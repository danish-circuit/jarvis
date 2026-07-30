type PiLogoProps = {
  className?: string;
};

/**
 * Pi's mark is the π glyph. Drawn as strokes rather than text so it renders
 * identically regardless of the font stack, matching the other provider logos.
 */
const PiLogo = ({ className = 'w-5 h-5' }: PiLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Pi"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M6.6 8.4h10.8M9.7 8.4v8.2M15 8.4v6.4c0 1 .5 1.8 1.6 1.8"
      className="stroke-background"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default PiLogo;
