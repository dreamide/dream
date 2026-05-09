import dreamSvg from "@/assets/dream.svg";
import Sparkles from "@/components/ui/sparkles";

type DreamLoadingScreenProps = {
  clockSync?: boolean;
  density?: number;
  height?: number;
  palette?: string[];
  position?: "top" | "bottom";
  shape?: "mixed" | "star" | "dot" | "glow" | "diamond" | "plus";
  sizeMul?: number;
  speed?: number;
  syncKey?: string;
};

export const DreamLoadingScreen = ({
  clockSync = true,
  density = 50,
  height = 256,
  palette = ["#ffffff", "#e0e4ff", "#b8beff", "#9098c9"],
  position = "bottom",
  shape = "mixed",
  sizeMul = 0.8,
  speed = 0.6,
  syncKey = "dream-loading-sparkles",
}: DreamLoadingScreenProps) => {
  return (
    <div
      aria-label="Loading Dream"
      className="fixed inset-0 z-50 grid place-items-center bg-background"
      role="status"
    >
      <div className="relative">
        <Sparkles
          clockSync={clockSync}
          density={density}
          height={height}
          palette={palette}
          position={position}
          shape={shape}
          sizeMul={sizeMul}
          speed={speed}
          syncKey={syncKey}
        >
          <div className="flex items-center justify-center h-64 w-16">
            <img
              alt=""
              className="relative z-10 size-16 opacity-85"
              draggable={false}
              src={dreamSvg}
            />
          </div>
        </Sparkles>
      </div>
    </div>
  );
};
