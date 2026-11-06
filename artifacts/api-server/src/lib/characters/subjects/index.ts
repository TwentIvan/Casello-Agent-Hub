// Punto unico di registrazione degli argomenti dei personaggi: importato da `app.ts` (e dai test che ne hanno bisogno).

import { registerSubject } from "../registry";
import { alfredThreadSubject } from "./alfred-thread";
import { agentSubject } from "./agent";
import { areaAgentsSubject, areaSkillsSubject, areaTemplatesSubject } from "./areas";
import { skillSubject } from "./skill";
import { teamTemplateSubject } from "./team-template";

for (const subject of [alfredThreadSubject, agentSubject, skillSubject, teamTemplateSubject, areaAgentsSubject, areaSkillsSubject, areaTemplatesSubject]) {
  registerSubject(subject);
}
