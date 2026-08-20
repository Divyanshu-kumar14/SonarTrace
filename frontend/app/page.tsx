import AudioStatus from "./components/AudioStatus";

export default function Home() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 text-slate-100"
    >
      <header className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">SonarTrace</h1>
        <p className="max-w-md text-slate-400">
          Accessible audio HUD — keyboard controls and live telemetry land in
          Phase 4.
        </p>
      </header>
      <AudioStatus />
    </main>
  );
}