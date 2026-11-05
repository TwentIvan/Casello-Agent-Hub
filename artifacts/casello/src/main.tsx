import { createRoot } from "react-dom/client";
import App from "./App";
// Prima i token di Botcave (fonte di verità: design/), poi Tailwind e gli alias di index.css
import "@design/tokens.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
