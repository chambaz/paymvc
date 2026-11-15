// Apply the saved preference before the app renders to prevent a theme flash.
(() => {
  let preference;
  try {
    preference = localStorage.getItem("paymvc:theme");
  } catch {
    // System preference still works when storage is unavailable.
  }
  const dark =
    preference === "dark" ||
    (preference !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
