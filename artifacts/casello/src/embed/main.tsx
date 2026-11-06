// Entrata di embed.html: /embed/callback (ritorno del popup) non monta React; /embed monta il pannello.
// Prima i token di Botcave (fonte di verità: design/), poi Tailwind e gli alias di index.css
import "@design/tokens.css";
import "../index.css";
import { runCallback } from "./callback";

const path = window.location.pathname.replace(/\/+$/, "");

if (path.endsWith("/embed/callback")) {
  runCallback();
} else {
  void Promise.all([import("react-dom/client"), import("./embed-app")]).then(([{ createRoot }, { EmbedApp }]) => {
    createRoot(document.getElementById("root")!).render(<EmbedApp />);
  });
}
