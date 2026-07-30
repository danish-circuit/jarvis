import crossSpawn from 'cross-spawn';

import { buildPiImageContents } from './shared/image-attachments.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

const activePiProcesses = new Map();

const PI_INSTALL_HINT = 'Pi CLI is not installed. Install it with: npm i -g @earendil-works/pi-coding-agent';

/**
 * Tools Pi is limited to in plan mode.
 *
 * Pi ships no permission system — its docs say so outright, and the RPC
 * protocol has no approval request at all. So "plan" cannot be a mode toggle
 * the way it is for Claude; the only real lever is the `--tools` allowlist,
 * which is enforced by refusing to hand the model any mutating tool.
 */
const PI_PLAN_MODE_TOOLS = ['read', 'grep', 'find', 'ls'];

const PI_PLAN_MODE_PROMPT =
  'You are in plan mode. Investigate and propose a plan; you have read-only tools and cannot modify files or run commands.';

/**
 * Maps the UI permission mode onto Pi's non-interactive controls.
 *
 * Only two of the app's modes are meaningful here:
 * - plan    → a read-only `--tools` allowlist plus a planning system prompt.
 * - default → Pi's normal behavior, where every built-in tool is available.
 *
 * `acceptEdits` and `bypassPermissions` are deliberately absent: Pi never gates
 * a tool call, so they would be indistinguishable from `default` and claiming
 * otherwise in the capability matrix would be a lie. See
 * providerCapabilitiesService for the matching declaration.
 *
 * Exported for tests only.
 */
export function resolvePiPermissionOptions(permissionMode) {
  if (permissionMode === 'plan') {
    return {
      args: ['--tools', PI_PLAN_MODE_TOOLS.join(','), '--append-system-prompt', PI_PLAN_MODE_PROMPT],
    };
  }

  return { args: [] };
}

/**
 * Picks the `--thinking` level for a run.
 *
 * Guarded against models that do not advertise the requested level so Pi never
 * exits early on an invalid-thinking-level diagnostic.
 *
 * Exported for tests only.
 */
export function resolvePiThinkingLevel(model, effort, modelsDefinition) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedLevels = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedLevels.includes(effort)
    ? effort
    : undefined;
}

async function spawnPi(command, options = {}, ws) {
  const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, permissionMode } = options;
  const workingDir = cwd || projectPath || process.cwd();
  const processKey = sessionId || Date.now().toString();

  const resolvedModel = await providerModelsService.resolveResumeModel('pi', sessionId, model);

  let effortModels = null;
  try {
    effortModels = (await providerModelsService.getProviderModels('pi')).models;
  } catch (error) {
    console.warn('[Pi] Unable to load provider models for thinking-level validation:', error);
  }

  // Read the images before the process starts: a failure here should surface as
  // a plain error rather than a half-sent prompt.
  const imageContents = await buildPiImageContents(images, workingDir);

  return new Promise((resolve, reject) => {
    let capturedSessionId = sessionId || null;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let piProcess = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    let usedTokens = { input: 0, output: 0 };
    // Pi exits 0 even when the turn failed on a provider error, so track it.
    let turnErrorMessage = null;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      // A provider error inside the turn still exits 0; report it as a failure
      // so the notification does not claim the run completed.
      if (code === 0 && !error && !turnErrorMessage) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'pi',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'pi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || turnErrorMessage || `Pi CLI exited with code ${code}`,
      });
    };

    const send = (fields) => {
      ws.send(createNormalizedMessage({
        sessionId: capturedSessionId || sessionId || null,
        provider: 'pi',
        ...fields,
      }));
    };

    const writeCommand = (payload) => {
      if (piProcess?.stdin?.writable) {
        piProcess.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      if (processKey !== capturedSessionId && piProcess) {
        activePiProcesses.delete(processKey);
        activePiProcesses.set(capturedSessionId, piProcess);
        piProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        send({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
        });
      }
    };

    /**
     * Accumulates usage so the run can report a token budget on close.
     *
     * Pi stamps usage onto each completed assistant message instead of tracking
     * a session running total, so the totals have to be summed here.
     */
    const accumulateUsage = (message) => {
      const usage = message?.usage;
      if (!usage || typeof usage !== 'object') {
        return;
      }

      const input = Number(usage.input || 0) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0);
      const output = Number(usage.output || 0);
      usedTokens = {
        input: usedTokens.input + (Number.isFinite(input) ? input : 0),
        output: usedTokens.output + (Number.isFinite(output) ? output : 0),
      };
    };

    const handleEvent = (event) => {
      const type = typeof event?.type === 'string' ? event.type : null;

      // The header line of a fresh transcript carries the canonical id.
      if (type === 'session' && typeof event.id === 'string') {
        registerSession(event.id);
        return;
      }

      if (type === 'response') {
        if (event.command === 'get_state' && event.success && event.data?.sessionId) {
          registerSession(event.data.sessionId);
          return;
        }

        if (event.success === false) {
          send({ kind: 'error', content: event.error || `Pi rejected "${event.command}"` });
        }
        return;
      }

      // Pi extensions can block on interactive UI. Nothing here can answer, so
      // cancel every request — without this a user with such an extension
      // installed gets a turn that silently hangs forever.
      if (type === 'extension_ui_request') {
        writeCommand({ type: 'extension_ui_response', id: event.id, cancelled: true });
        return;
      }

      if (type === 'message_end') {
        accumulateUsage(event.message);
        const stopReason = event.message?.stopReason;
        if (stopReason === 'error' || stopReason === 'aborted') {
          turnErrorMessage = event.message?.errorMessage || `Pi turn ended with stopReason "${stopReason}"`;
        }
      }

      for (const message of sessionsService.normalizeMessage('pi', event, capturedSessionId || sessionId || null)) {
        ws.send(message);
      }

      // `agent_end` closes the turn. Ending stdin lets Pi flush and exit
      // cleanly, which is what keeps the transcript file well-formed.
      if (type === 'agent_end' && piProcess?.stdin?.writable) {
        piProcess.stdin.end();
      }
    };

    const processPiOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        send({ kind: 'stream_delta', content: line });
        return;
      }

      try {
        handleEvent(event);
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Pi] Failed to process RPC event:', errorContent);
        send({ kind: 'error', content: errorContent });
      }
    };

    const resolvedThinking = resolvePiThinkingLevel(resolvedModel, effort, effortModels);
    const args = ['--mode', 'rpc'];
    if (sessionId) {
      args.push('--session', sessionId);
    }
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }
    if (resolvedThinking) {
      args.push('--thinking', resolvedThinking);
    }
    args.push(...resolvePiPermissionOptions(permissionMode).args);

    piProcess = spawnFunction('pi', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    activePiProcesses.set(processKey, piProcess);
    piProcess.sessionId = processKey;

    piProcess.stdout.on('data', (data) => {
      stdoutLineBuffer += data.toString();
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';

      completeLines.forEach((line) => {
        processPiOutputLine(line.trim());
      });
    });

    piProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      if (!stderrText.trim()) {
        return;
      }

      send({ kind: 'error', content: stderrText });
    });

    piProcess.on('close', (code) => {
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activePiProcesses.delete(finalSessionId);
      activePiProcesses.delete(processKey);

      if (stdoutLineBuffer.trim()) {
        processPiOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      const used = usedTokens.input + usedTokens.output;
      if (used > 0) {
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: {
            used,
            inputTokens: usedTokens.input,
            outputTokens: usedTokens.output,
            breakdown: { input: usedTokens.input, output: usedTokens.output },
          },
          sessionId: finalSessionId,
          provider: 'pi',
        }));
      }

      // Terminal complete — skipped for aborted runs (abort-session already
      // sent the aborted complete on this run's behalf).
      if (!completeSent && !piProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'pi', sessionId: finalSessionId, exitCode: code }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      // An aborted run exits non-zero by design; that is a user action, not a
      // failure worth reporting or rejecting on.
      if (piProcess.aborted) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'pi',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'aborted',
        });
        terminalNotificationSent = true;
        resolve();
        return;
      }

      void (async () => {
        if (code === 127 || code === null) {
          const installed = await providerAuthService.isProviderInstalled('pi');
          if (!installed) {
            send({ kind: 'error', content: PI_INSTALL_HINT });
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'Pi CLI process was terminated' : `Pi CLI exited with code ${code}`));
      })();
    });

    piProcess.on('error', (error) => {
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activePiProcesses.delete(finalSessionId);
      activePiProcesses.delete(processKey);

      void (async () => {
        const installed = await providerAuthService.isProviderInstalled('pi');
        send({ kind: 'error', content: installed ? error.message : PI_INSTALL_HINT });

        if (!completeSent && !piProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'pi', sessionId: finalSessionId, exitCode: 1 }));
        }
        notifyTerminalState({ error });
        reject(error);
      })();
    });

    // Ask for the session id up front so a brand-new conversation can be mapped
    // before any assistant output arrives, then send the turn itself.
    writeCommand({ type: 'get_state' });
    writeCommand({
      type: 'prompt',
      message: command || '',
      ...(imageContents.length > 0 ? { images: imageContents } : {}),
    });
  });
}

/**
 * Cancels a running Pi turn.
 *
 * Prefers the protocol-level `abort` over a signal so Pi can unwind the agent
 * loop and finish writing its transcript; SIGTERM is only the backstop for a
 * process that has stopped reading stdin.
 */
const PI_ABORT_GRACE_MS = 2000;

function abortPiSession(sessionId) {
  const piProcess = activePiProcesses.get(sessionId);
  if (!piProcess) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  piProcess.aborted = true;

  if (piProcess.stdin?.writable) {
    piProcess.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`);
    piProcess.stdin.end();
    setTimeout(() => {
      if (!piProcess.killed) {
        piProcess.kill('SIGTERM');
      }
    }, PI_ABORT_GRACE_MS).unref?.();
  } else {
    piProcess.kill('SIGTERM');
  }

  activePiProcesses.delete(sessionId);
  return true;
}

function isPiSessionActive(sessionId) {
  return activePiProcesses.has(sessionId);
}

function getActivePiSessions() {
  return Array.from(activePiProcesses.keys());
}

export {
  spawnPi,
  abortPiSession,
  isPiSessionActive,
  getActivePiSessions,
};
