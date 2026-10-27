export default function AppRouteLoading() {
  return (
    <div className="page route-loading-page" aria-busy="true" aria-live="polite">
      <span className="sr-only">正在打开模块</span>
      <header className="route-loading-header" aria-hidden="true">
        <span className="route-loading-line short" />
        <span className="route-loading-line" />
      </header>
      <section className="route-loading-panel" aria-hidden="true">
        <div className="route-loading-column">
          {Array.from({ length: 6 }).map((_, index) => (
            <span className="route-loading-block" key={index} />
          ))}
        </div>
        <div className="route-loading-column wide">
          {Array.from({ length: 4 }).map((_, index) => (
            <span className="route-loading-block" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}
