import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isNewerVersion,
  ProviderCliVersionUnsupportedError,
  providerCliVersionService,
} from '@/modules/providers/services/provider-cli-version.service.js';

test('isNewerVersion compares dotted numeric versions', () => {
  assert.equal(isNewerVersion('0.85.0', '0.84.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.9'), true);
  assert.equal(isNewerVersion('0.84.0', '0.84.0'), false);
  assert.equal(isNewerVersion('0.83.0', '0.84.0'), false);
});

test('isNewerVersion refuses to nag over unparseable input', () => {
  assert.equal(isNewerVersion('next', '0.84.0'), false);
  assert.equal(isNewerVersion('0.85.0', 'not-a-version'), false);
});

test('getCliVersion rejects providers without a CLI descriptor', async () => {
  await assert.rejects(
    () => providerCliVersionService.getCliVersion('codex'),
    ProviderCliVersionUnsupportedError,
  );
});

test('getCliVersion supports pi without throwing unsupported', async () => {
  // pi and the npm registry may both be absent in the test environment; the
  // contract under test is only that pi is a managed CLI, so nulls are fine.
  const version = await providerCliVersionService.getCliVersion('pi');
  assert.equal(version.provider, 'pi');
  assert.equal(version.executablePath, 'pi');
});
