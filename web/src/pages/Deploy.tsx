import { Page } from "../ui.tsx";
import { SetupGuide, useSetupStatus } from "../setup.tsx";

export default function Deploy() {
  const q = useSetupStatus();
  return (
    <Page title="Implantação">
      <SetupGuide status={q.data} />
    </Page>
  );
}
