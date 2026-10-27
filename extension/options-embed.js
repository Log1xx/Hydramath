// Runs before first paint: compact layout when shown inside the panel (?embedded).
if (new URLSearchParams(location.search).has("embedded")) document.documentElement.classList.add("embedded");
