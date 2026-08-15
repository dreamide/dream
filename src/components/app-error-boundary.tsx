import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled renderer error", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          {error.message || String(error)}
        </p>
        {error.stack ? (
          <pre className="max-h-64 max-w-3xl overflow-auto rounded-md border bg-muted p-3 text-left font-mono text-xs">
            {error.stack}
          </pre>
        ) : null}
        <button
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          onClick={this.handleReload}
          type="button"
        >
          Reload
        </button>
      </div>
    );
  }
}
