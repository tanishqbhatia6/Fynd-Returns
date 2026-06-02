import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ReturnPortalApp } from "./App";
import { readBootstrap } from "./utils";

class PortalErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Return portal render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="rpm-boot-fallback rpm-boot-error" role="alert">
          <div className="rpm-brand-row">
            <div className="rpm-brand-mark">
              <span>F</span>
            </div>
            <div>
              <div className="rpm-brand-name">Fynd Returns</div>
              <div className="rpm-brand-shop">Customer portal</div>
            </div>
          </div>
          <div className="rpm-hero-main">
            <div className="rpm-hero-copy-block">
              <h1>Portal could not load</h1>
              <p className="rpm-hero-copy">Reload the page. If this continues, contact the store.</p>
            </div>
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}

const root = document.getElementById("return-portal-root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <PortalErrorBoundary>
        <ReturnPortalApp bootstrap={readBootstrap()} />
      </PortalErrorBoundary>
    </StrictMode>,
  );
}
