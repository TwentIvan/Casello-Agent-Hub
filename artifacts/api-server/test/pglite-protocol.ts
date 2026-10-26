import type { PGlite } from "@electric-sql/pglite";

// PGLiteSocketServer (@electric-sql/pglite-socket 0.2.14-0.2.15) serve tutte le connessioni con
// un'unica sessione PGlite: mette in coda i messaggi uno per uno e resta su una sola connessione
// soltanto dentro una transazione esplicita (`db.isInTransaction()`). Fuori da una transazione i
// messaggi del protocollo esteso (Parse/Bind/Describe/Execute/Sync) di connessioni diverse si
// alternano e condividono statement e portale senza nome: una query riceve i parametri o il
// risultato di un'altra (es. "invalid input value for enum ai_provider: \"dev@localhost\"").
// Qui la coda vede "in transazione" anche una sequenza estesa aperta, fino al suo Sync.

const QUERY = 0x51; // 'Q': query semplice, completa in un solo messaggio
const SYNC = 0x53; // 'S': chiude la sequenza estesa
const TERMINATE = 0x58; // 'X'

export function serializeExtendedProtocol(db: PGlite): void {
  let openSequence = false;
  const exec = db.execProtocolRawStream.bind(db);
  const inTransaction = db.isInTransaction.bind(db);
  db.execProtocolRawStream = (message, options) => {
    const type = message[0];
    // Il messaggio di avvio non ha un tipo: il suo primo byte è 0
    openSequence = !(type === SYNC || type === QUERY || type === TERMINATE || type === 0);
    return exec(message, options);
  };
  db.isInTransaction = () => openSequence || inTransaction();
}
