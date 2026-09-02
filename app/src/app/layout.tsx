import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "First United Bank — Real-Time Banking Demo",
  description: "Snowflake hybrid table + Snowpipe Streaming banking demo",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bg-bank-navy text-white shadow-md">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Simple bank logo mark */}
              <div className="w-8 h-8 rounded bg-bank-sky flex items-center justify-center font-bold text-white text-sm">
                FUB
              </div>
              <div>
                <div className="font-semibold text-lg leading-tight">First United Bank</div>
                <div className="text-xs text-blue-200">Real-Time Core Banking Demo</div>
              </div>
            </div>
            <nav className="flex gap-6 text-sm">
              <a href="/"         className="text-blue-200 hover:text-white transition-colors">Live Feed</a>
              <a href="/pipeline" className="text-blue-200 hover:text-white transition-colors">Pipeline</a>
              <a href="/demo"     className="text-blue-200 hover:text-white transition-colors">Demo Controls</a>
            </nav>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </main>
        <footer className="mt-16 border-t border-slate-200 py-4">
          <div className="max-w-7xl mx-auto px-6 text-xs text-slate-400 flex justify-between">
            <span>Powered by Snowflake Hybrid Tables + Snowpipe Streaming</span>
            <span>snowhouse account · FUB_DEMO.BANKING</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
