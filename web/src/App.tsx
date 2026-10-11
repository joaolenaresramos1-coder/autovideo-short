import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { configured } from "./supabase.ts";
import { useSession } from "./hooks.ts";
import { Loading } from "./ui.tsx";
import Login from "./pages/Login.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Works from "./pages/Works.tsx";
import WorkForm from "./pages/WorkForm.tsx";
import WorkDetail from "./pages/WorkDetail.tsx";
import Calendar from "./pages/Calendar.tsx";
import Queue from "./pages/Queue.tsx";
import Scripts from "./pages/Scripts.tsx";
import Videos from "./pages/Videos.tsx";
import Publications from "./pages/Publications.tsx";
import Integrations from "./pages/Integrations.tsx";
import Costs from "./pages/Costs.tsx";
import Storage from "./pages/Storage.tsx";
import Settings from "./pages/Settings.tsx";
import Deploy from "./pages/Deploy.tsx";
import { SetupGuide } from "./setup.tsx";

const MAIN = [
  { to: "/", icon: "⌂", label: "Início" },
  { to: "/obras", icon: "▤", label: "Obras" },
  { to: "/calendario", icon: "▦", label: "Calendário" },
  { to: "/fila", icon: "⟳", label: "Fila" },
];
const MORE = [
  { to: "/roteiros", icon: "✎", label: "Roteiros" },
  { to: "/videos", icon: "▶", label: "Vídeos" },
  { to: "/publicacoes", icon: "↗", label: "Publicações" },
  { to: "/integracoes", icon: "⚭", label: "Integrações" },
  { to: "/custos", icon: "$", label: "Custos" },
  { to: "/armazenamento", icon: "◔", label: "Armazenamento" },
  { to: "/config", icon: "⚙", label: "Logs e config." },
  { to: "/implantacao", icon: "✓", label: "Implantação" },
];

function NotConfigured() {
  return (
    <main className="login">
      <h1>Configuração pendente</h1>
      <p>
        Este site ainda não foi ligado a um projeto Supabase. Siga os passos abaixo; depois de definir{" "}
        <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> e publicar de novo, o painel abre normalmente.
      </p>
      <SetupGuide />
    </main>
  );
}

export default function App() {
  const { session, loading } = useSession();
  const [more, setMore] = useState(false);
  const location = useLocation();
  if (!configured) return <NotConfigured />;
  if (loading) return <Loading />;
  if (!session) return <Login />;
  const moreActive = MORE.some((m) => location.pathname.startsWith(m.to));

  return (
    <div className="app">
      <nav className="side-nav" aria-label="Navegação principal">
        <div className="brand"><span className="brand-mark" aria-hidden /> AutoVideo</div>
        {[...MAIN, ...MORE].map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === "/"}>
            <span aria-hidden>{l.icon}</span> {l.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/obras" element={<Works />} />
        <Route path="/obras/nova" element={<WorkForm />} />
        <Route path="/obras/:id" element={<WorkDetail />} />
        <Route path="/obras/:id/editar" element={<WorkForm />} />
        <Route path="/calendario" element={<Calendar />} />
        <Route path="/fila" element={<Queue />} />
        <Route path="/roteiros" element={<Scripts />} />
        <Route path="/videos" element={<Videos />} />
        <Route path="/publicacoes" element={<Publications />} />
        <Route path="/integracoes" element={<Integrations />} />
        <Route path="/custos" element={<Costs />} />
        <Route path="/armazenamento" element={<Storage />} />
        <Route path="/config" element={<Settings />} />
        <Route path="/implantacao" element={<Deploy />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>

      <nav className="bottom-nav" aria-label="Navegação">
        {MAIN.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === "/"} onClick={() => setMore(false)}>
            <span className="icon" aria-hidden>{l.icon}</span>
            {l.label}
          </NavLink>
        ))}
        <button className={moreActive ? "active" : ""} onClick={() => setMore((v) => !v)} aria-expanded={more}>
          <span className="icon" aria-hidden>☰</span>
          Mais
        </button>
      </nav>
      {more && (
        <>
          <div className="sheet-backdrop" onClick={() => setMore(false)} />
          <div className="sheet" role="dialog" aria-label="Mais opções">
            {MORE.map((l) => (
              <NavLink key={l.to} to={l.to} onClick={() => setMore(false)}>
                <span className="icon" aria-hidden>{l.icon}</span>
                {l.label}
              </NavLink>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
