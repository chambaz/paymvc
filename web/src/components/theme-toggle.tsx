import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

// The demo's theme toggle without the Radix dependency. Both use the same storage key.
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
    <button
      type="button"
      aria-pressed={theme === "dark"}
      aria-label="Dark mode"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex h-9 min-w-9 items-center justify-center rounded-md border border-input bg-transparent px-2 shadow-xs transition-[color,box-shadow] outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-accent aria-pressed:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
      onClick={() => {
        const value = theme === "dark" ? "light" : "dark";
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
    </button>
  );
}
