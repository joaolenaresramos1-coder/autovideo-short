import { Page } from "../ui.tsx";
import { SetupGuide, useSetupStatus } from "../setup.tsx";
import { ServerSetup } from "../serverSetup.tsx";

export default function Deploy() {
  const q = useSetupStatus();
  return (
    <Page title="Implantação">
      <div className="stack">
        <ServerSetup />
        <details>
          <summary style={{ minHeight: 44, display: "flex", alignItems: "center" }}>Guia manual (passo a passo)</summary>
          <SetupGuide status={q.data} />
        </details>
      </div>
    </Page>
  );
}
