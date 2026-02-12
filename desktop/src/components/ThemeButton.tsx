import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";

interface ThemeButtonProps {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  showLabel?: boolean;
}

export function ThemeButton({
  variant = "outline",
  size = "sm",
  showLabel = true,
}: ThemeButtonProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <Button variant={variant} size={size} onClick={toggleTheme}>
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
      {showLabel && (
        <span>{theme === "dark" ? "Light" : "Dark"}</span>
      )}
    </Button>
  );
}
