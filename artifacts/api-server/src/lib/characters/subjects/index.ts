// Punto unico di registrazione degli argomenti dei personaggi: importato da `app.ts` (e dai test che ne hanno bisogno).
// I Task successivi aggiungono qui gli argomenti di Lucius.

import { registerSubject } from "../registry";
import { alfredThreadSubject } from "./alfred-thread";

registerSubject(alfredThreadSubject);
