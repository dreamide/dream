import { IdeShell } from "@/components/ide/ide-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export const App = () => {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
      storageKey="dream-theme"
    >
      <TooltipProvider>
        <IdeShell />
      </TooltipProvider>
    </ThemeProvider>
  );
};
