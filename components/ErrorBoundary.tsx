import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    this.setState({
      error: error,
      errorInfo: errorInfo
    });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-10 min-h-screen bg-gray-900 text-white font-sans w-full h-full">
          <div className="max-w-2xl bg-gray-800 p-8 rounded-lg border border-red-500 shadow-2xl">
            <h1 className="text-3xl font-bold text-red-400 mb-4 flex items-center">
              <span className="mr-3 text-4xl">⚠️</span> Application Error
            </h1>
            <p className="text-gray-300 mb-6 text-lg">
              The application encountered an unexpected error. Plase share the details below:
            </p>
            <div className="bg-black/50 p-4 rounded border border-gray-700 overflow-auto max-h-[300px] mb-6">
              <pre className="text-red-300 font-mono text-sm whitespace-pre-wrap">
                {this.state.error && this.state.error.toString()}
                <br />
                {this.state.errorInfo?.componentStack}
              </pre>
            </div>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null, errorInfo: null });
                window.location.reload();
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-6 rounded transition-colors w-full"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
