import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";

type Theme = "light" | "dark";
const storageKey = "paymvc:theme";

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function ThemeToggle() {
  const [preference, setPreference] = useState(savedTheme);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme = preference ?? (systemDark ? "dark" : "light");

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const updateSystem = () => setSystemDark(media.matches);
    const updatePreference = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null)
        setPreference(savedTheme());
    };
    media.addEventListener("change", updateSystem);
    window.addEventListener("storage", updatePreference);
    return () => {
      media.removeEventListener("change", updateSystem);
      window.removeEventListener("storage", updatePreference);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  return (
    <Toggle
      variant="outline"
      pressed={theme === "dark"}
      aria-label="Dark mode"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onPressedChange={(pressed) => {
        const value = pressed ? "dark" : "light";
        setPreference(value);
        try {
          localStorage.setItem(storageKey, value);
        } catch {
          // Keep the selection for this page when storage is unavailable.
        }
      }}
    >
      {theme === "dark" ? (
        <MoonIcon aria-hidden="true" />
      ) : (
        <SunIcon aria-hidden="true" />
      )}
    </Toggle>
  );
}
