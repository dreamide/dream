import dreamSvg from "@/assets/dream.svg";
import Sparkles from "@/components/ui/sparkles";
import {
  DREAM_LOADING_SPARKLES,
  DREAM_LOADING_SPARKLES_PALETTE,
} from "./dream-loading-screen-config";

export const DreamLoadingScreen = () => {
  return (
    <div
      aria-label="Loading Dream"
      className="fixed inset-0 z-50 grid place-items-center bg-background"
      role="status"
    >
      <div className="relative">
        <img
          alt=""
          className="relative z-10 size-16 opacity-85"
          draggable={false}
          src={dreamSvg}
        />
        <Sparkles
          clockSync={DREAM_LOADING_SPARKLES.clockSync}
          density={DREAM_LOADING_SPARKLES.density}
          height={DREAM_LOADING_SPARKLES.height}
          palette={DREAM_LOADING_SPARKLES_PALETTE}
          position={DREAM_LOADING_SPARKLES.position}
          shape={DREAM_LOADING_SPARKLES.shape}
          sizeMul={DREAM_LOADING_SPARKLES.sizeMul}
          speed={DREAM_LOADING_SPARKLES.speed}
          syncKey={DREAM_LOADING_SPARKLES.syncKey}
        >
          <div className="h-48 w-full" />
        </Sparkles>
      </div>
    </div>
  );
};
