/** Render the official theme-appropriate DotaTel wordmark from bundled assets. */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={`brand ${className}`}>
      <img
        className="brand-dark"
        src="/assets/dotatel-logo-dark.svg"
        alt="DotaTel"
        width="188"
        height="34"
        draggable="false"
      />
      <img
        className="brand-light"
        src="/assets/dotatel-logo-primary.svg"
        alt="DotaTel"
        width="188"
        height="34"
        draggable="false"
      />
    </div>
  );
}
