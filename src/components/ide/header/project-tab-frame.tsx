import type { PropsWithChildren } from "react";
import Sparkles from "@/components/ui/sparkles";

export const ProjectTabFrame = ({
  children,
  streaming,
}: PropsWithChildren<{ streaming: boolean }>) => (
  <Sparkles
    className="w-full overflow-hidden"
    density={38}
    disabled={!streaming}
    groundGlow={true}
    height={10}
    palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
    position="bottom"
    sizeMul={0.5}
    speed={3}
    style={{ position: "relative" }}
    sway={0}
  >
    {children}
  </Sparkles>
);
