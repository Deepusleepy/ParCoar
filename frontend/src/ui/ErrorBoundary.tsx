import { Component, type ErrorInfo, type ReactNode } from "react";

// The app is a WebGL scene; a thrown render error would otherwise white-screen
// the whole page with nothing to tell the user what happened.
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0b0e] px-6 text-center">
        <div className="max-w-md rounded-lg border border-red-500/30 bg-black/60 p-5">
          <div className="text-sm font-semibold text-red-300">GARAGE COULD NOT START</div>
          <p className="mt-2 break-words text-xs leading-relaxed text-neutral-400">
            {error.message}
          </p>
          <button
            type="button"
            className="mt-4 rounded border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:border-neutral-500"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
