import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Prevents a render crash from leaving only the HTML shell background visible. */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen w-screen flex items-center justify-center p-6 bg-surface-50 dark:bg-surface-950 text-surface-900 dark:text-surface-50">
          <div className="max-w-lg w-full rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-6 space-y-3 shadow-sm">
            <h1 className="text-lg font-bold">Something went wrong</h1>
            <p className="text-sm text-surface-600 dark:text-surface-300">
              The UI hit an error. Reload the app to continue. If it keeps happening, check Diagnostics.
            </p>
            <pre className="text-xs font-mono max-h-40 overflow-auto rounded-lg bg-surface-100 dark:bg-surface-950 p-3 text-red-600 dark:text-red-300">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
