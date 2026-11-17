# Integrare Botcave nella tua app

Questa guida spiega come aggiungere il pannello di Botcave a un'applicazione web, con qualunque tecnologia lato server, e come
far sapere a Botcave chi è l'utente collegato, così che le segnalazioni dei bug siano legate a una persona e non solo a un browser.

Servono due cose: una riga `<script>` nelle pagine e, per l'identità, un endpoint nel server della tua app che emette un token breve.

## 1. Cosa serve in Botcave

L'abilitazione la fa l'amministratore di Botcave:

1. **Origine ammessa**: l'origine della tua app (`https://app.esempio.it`, senza percorso) va in `EMBED_ALLOWED_ORIGINS`, sia su `casello-api`
   sia su `casello-web`. Senza, il pannello mostra «Questa app non è abilitata a Botcave».
2. **App registrata**: l'App esiste in Botcave con il suo `slug` (lo useri in `data-app` e nel token).
3. **Segnalazioni dei bug**: nella scheda App, carta «Segnalazioni bug», attiva l'interruttore.
4. **Segreto d'identità** (facoltativo, serve per riconoscere gli utenti): nella stessa carta, «Genera segreto d'identità». Il segreto
   (`bci_` seguito da 43 caratteri) si mostra una volta sola: copialo subito nella configurazione **del server** della tua app.
   «Rigenera» invalida il precedente, «Togli» lo cancella. Con «Prova identità» incolli un token e Botcave ti dice se è valido o perché no.

## 2. Lo script

```html
<script src="https://casello.fantamister.cloud/embed/v1/botcave.js"
        data-app="mia-app"
        data-identity-url="/botcave/identity"
        defer></script>
```

| Attributo | Obbligatorio | Significato |
|---|---|---|
| `data-app` | sì | Lo slug dell'App in Botcave. Senza, nessun pulsante e un avviso in console. |
| `data-mount` | no | Selettore CSS dell'elemento in cui mettere il pulsante; predefinito il `body`. |
| `data-position` | no | `right` (predefinito) o `left`. |
| `data-identity-url` | no | Percorso dell'endpoint d'identità (vedi sotto). |

Il pulsante apre un pannello laterale (a schermo intero sotto i 640 px). Il pannello vive in un iframe di Botcave: la tua pagina
non vede mai i token di accesso di Botcave.

### Contesto della pagina

Puoi dire a Botcave in che pagina si trova l'utente; la segnalazione di un bug lo riporta.

```js
Botcave.setContext({ page: "ordine", id: "A-1042", title: "Ordine A-1042" });
Botcave.open("bugs");   // apre il pannello sulla scheda Segnalazioni
Botcave.close();
```

`page` e `id` sono 1..40 caratteri tra lettere, cifre e `. _ : -`; `title` al più 200 caratteri su una riga. Un contesto non valido è
ignorato con un avviso in console. Le chiamate fatte prima del caricamento dello script si accodano da sole. Le schede per
`open` sono `alfred`, `pending`, `bulletin`, `lucius` e `bugs`.

### Tema

Il pannello legge dall'elemento `<html>` della tua pagina le variabili CSS `--background`, `--foreground`, `--primary`,
`--primary-foreground`, `--muted`, `--muted-foreground`, `--border`, `--radius`, `--font-sans` e il tema chiaro o scuro
(classe `dark` o `data-theme`), e le rimanda al cambio. Valori ammessi: colori (`H S% L%`, `#rgb`, `rgb()`, `hsl()`, `oklch()`),
lunghezze (`rem`, `px`) e famiglie di font. Ogni altro valore è scartato.

## 3. L'identità degli utenti

Senza identità, le segnalazioni sono legate a una chiave anonima del browser. Con l'identità Botcave sa chi segnala, mostra a ogni
persona le sue segnalazioni su qualunque dispositivo e può rispondere con il nome giusto.

### Come funziona

1. Il pannello (il caricatore nella tua pagina) chiama `GET <data-identity-url>` con i cookie della tua app (`credentials: same-origin`):
   all'apertura del pannello, circa un minuto prima della scadenza del token e quando il pannello lo chiede (al più una richiesta non
   pianificata ogni 10 secondi).
2. Il tuo server riconosce l'utente dalla sua sessione e risponde con un token firmato, oppure con `204` se nessuno è collegato.
3. Il token passa al pannello, che lo manda a Botcave con la segnalazione. Botcave lo verifica con il segreto condiviso.

Il percorso deve essere **relativo alla radice** della tua app: comincia con `/`, non con `//`, al più 500 caratteri, senza `\` né caratteri di controllo. Un indirizzo
assoluto è ignorato con un avviso, perché i cookie della tua app non devono mai andare altrove. La richiesta non segue redirect: se
l'endpoint risponde 3xx (per esempio verso una pagina di login) la richiesta fallisce e il pannello resta anonimo, quindi per un utente
non collegato rispondi `204`, non un redirect.

### Risposte dell'endpoint

| Risposta | Quando |
|---|---|
| `200` con `{"token": "<jwt>"}` | utente collegato (`Content-Type: application/json`) |
| `204` senza corpo | nessun utente collegato |
| altro | il pannello resta anonimo e scrive un avviso in console |

Il token non deve superare 4 096 caratteri. Aggiungi `Cache-Control: no-store`.

### Il token

JWT compatto (`header.payload.firma`, base64url senza padding), firmato HS256.

- **Header**: `{"alg":"HS256","typ":"JWT"}`. Qualunque altro `alg`, `none` compreso, è rifiutato.
- **Chiave**: l'**intera stringa del segreto** (`bci_…`) come testo UTF-8. Non decodificarla e non togliere il prefisso `bci_`.
- **Claim**:

| Claim | Valore |
|---|---|
| `iss` | lo slug dell'App in Botcave (lo stesso di `data-app`) |
| `aud` | `"botcave"` |
| `sub` | id stabile dell'utente nella tua app, 1..200 caratteri |
| `iat` | istante di emissione, secondi Unix |
| `exp` | scadenza, secondi Unix, **al più `iat + 600`** |
| `name` | facoltativo, al più 100 caratteri (unità UTF-16) |
| `email` | facoltativo, al più 254 caratteri (unità UTF-16) |

**Attenzione ai limiti di `name` ed `email`**: un `name` oltre 100 o un `email` oltre 254 caratteri rende **non valido l'intero token**
(non vengono troncati da Botcave: l'utente resta anonimo). Tronca sempre questi campi nel tuo server, oppure omettili. Botcave conta
le unità UTF-16, come `String.length` di JavaScript, Java e .NET; Python e PHP contano invece i punti di codice, quindi con nomi che
contengono emoji o caratteri fuori dal piano base (due unità UTF-16 ciascuno) misura in UTF-16 o tronca in modo prudente (per esempio a 50).

Botcave tollera 60 secondi di scarto tra gli orologi. I claim sconosciuti sono ignorati. Errori restituiti: «identità non valida»
(formato, firma, `iss`, `aud`, lunghezze, `exp` oltre `iat + 600`) e «identità scaduta».

Con il segreto configurato, un token **presente ma non valido o scaduto blocca la segnalazione**: Botcave risponde `401` e non ripiega
sulla chiave del browser. Il pannello chiede allora un token nuovo al tuo endpoint e riprova una volta sola; se anche il secondo token
è rifiutato la segnalazione non parte e l'utente vede l'errore (se invece l'endpoint risponde `204`, la seconda prova parte anonima con
la chiave del browser). Un endpoint che emette token sbagliati impedisce quindi di segnalare a tutti gli utenti collegati: usa «Prova
identità» per capire perché.

Se l'App non ha un segreto, un token presente è ignorato e si usa la chiave del browser.

## 4. Esempi dell'endpoint

Tutti gli esempi leggono il segreto e lo slug dall'ambiente (`BOTCAVE_IDENTITY_SECRET`, `BOTCAVE_APP`) e rispondono `204` se nessun
utente è collegato. Sostituisci il modo di riconoscere l'utente (`currentUser`, `request.user`, …) con quello della tua app.

### Node.js (Express)

Il file [`esempi/botcave-identity.mjs`](./esempi/botcave-identity.mjs) è eseguibile e usa solo `node:crypto`. Prova locale:

```sh
BOTCAVE_IDENTITY_SECRET=bci_... BOTCAVE_APP=mia-app node docs/integrazione/esempi/botcave-identity.mjs
```

```js
import express from "express";
import { signBotcaveToken } from "./botcave-identity.mjs";

const app = express();

app.get("/botcave/identity", (req, res) => {
  const user = req.session?.user; // la tua sessione
  res.set("Cache-Control", "no-store");
  if (!user) return res.sendStatus(204);
  const token = signBotcaveToken(
    { id: String(user.id), name: user.name, email: user.email },
    { secret: process.env.BOTCAVE_IDENTITY_SECRET, appSlug: process.env.BOTCAVE_APP, ttlSeconds: 300 },
  );
  res.json({ token });
});
```

### Python (Flask)

```python
import base64, hashlib, hmac, json, os, time
from flask import Flask, jsonify, session

app = Flask(__name__)

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def botcave_token(user_id: str, name=None, email=None, ttl=300) -> str:
    now = int(time.time())
    claims = {"iss": os.environ["BOTCAVE_APP"], "aud": "botcave", "sub": user_id,
              "iat": now, "exp": now + min(ttl, 600)}
    # [:100] conta punti di codice, Botcave unità UTF-16: con emoji tronca più corto (es. 50)
    if name: claims["name"] = name[:100]
    if email: claims["email"] = email[:254]
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps(claims, separators=(",", ":")).encode())
    key = os.environ["BOTCAVE_IDENTITY_SECRET"].encode("utf-8")  # la stringa intera bci_...
    sig = b64url(hmac.new(key, f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"

@app.get("/botcave/identity")
def botcave_identity():
    user = session.get("user")  # la tua sessione
    if not user:
        return "", 204
    resp = jsonify(token=botcave_token(str(user["id"]), user.get("name"), user.get("email")))
    resp.headers["Cache-Control"] = "no-store"
    return resp
```

### Python (Django)

Usa la stessa funzione `botcave_token` dell'esempio Flask (in un modulo tuo) e questa vista:

```python
# views.py
from django.http import HttpResponse, JsonResponse
from .botcave import botcave_token

def botcave_identity(request):
    if not request.user.is_authenticated:
        return HttpResponse(status=204)
    resp = JsonResponse({"token": botcave_token(
        str(request.user.pk), request.user.get_full_name() or None, request.user.email or None)})
    resp["Cache-Control"] = "no-store"
    return resp

# urls.py
# path("botcave/identity", views.botcave_identity),
```

### PHP

```php
<?php
// botcave-identity.php, instradato su GET /botcave/identity
session_start();

function b64url(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function botcave_token(string $id, ?string $name, ?string $email, int $ttl = 300): string {
    $slug = getenv('BOTCAVE_APP');
    $secret = getenv('BOTCAVE_IDENTITY_SECRET');
    if ($slug === false || $secret === false || $slug === '' || $secret === '') {
        throw new RuntimeException('BOTCAVE_APP e BOTCAVE_IDENTITY_SECRET devono essere impostate');
    }
    $now = time();
    $claims = ['iss' => $slug, 'aud' => 'botcave', 'sub' => $id,
               'iat' => $now, 'exp' => $now + min($ttl, 600)];
    // mb_substr conta punti di codice, Botcave unità UTF-16: con emoji tronca più corto (es. 50)
    if ($name) $claims['name'] = mb_substr($name, 0, 100);
    if ($email) $claims['email'] = mb_substr($email, 0, 254);
    $header = b64url(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $payload = b64url(json_encode($claims, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    $sig = b64url(hash_hmac('sha256', "$header.$payload", $secret, true));
    return "$header.$payload.$sig";
}

$user = $_SESSION['user'] ?? null; // la tua sessione
if (!$user) { http_response_code(204); exit; }
header('Content-Type: application/json');
header('Cache-Control: no-store');
echo json_encode(['token' => botcave_token((string)$user['id'], $user['name'] ?? null, $user['email'] ?? null)]);
```

### Java (Spring Boot)

Solo JDK e Jackson (già presente in Spring Web).

```java
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Instant;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
class BotcaveIdentityController {
    private static final ObjectMapper JSON = new ObjectMapper();
    @Value("${BOTCAVE_IDENTITY_SECRET}") String secret;
    @Value("${BOTCAVE_APP}") String appSlug;

    @GetMapping("/botcave/identity")
    ResponseEntity<Map<String, String>> identity(Principal principal) throws Exception {
        if (principal == null) return ResponseEntity.noContent().build();
        long iat = Instant.now().getEpochSecond();
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", appSlug);
        claims.put("aud", "botcave");
        claims.put("sub", principal.getName());           // id stabile dell'utente
        claims.put("iat", iat);
        claims.put("exp", iat + 300);
        String displayName = null; // nome e email dal tuo archivio utenti (mai dai parametri della richiesta)
        String mail = null;
        // name/email facoltativi; String.length() conta unità UTF-16, come Botcave: oltre 100/254 il token sarebbe non valido
        if (displayName != null && !displayName.isEmpty()) claims.put("name", clamp(displayName, 100));
        if (mail != null && !mail.isEmpty()) claims.put("email", clamp(mail, 254));
        String header = b64(JSON.writeValueAsBytes(Map.of("alg", "HS256", "typ", "JWT")));
        String payload = b64(JSON.writeValueAsBytes(claims));
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256")); // stringa intera bci_...
        String sig = b64(mac.doFinal((header + "." + payload).getBytes(StandardCharsets.UTF_8)));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(Map.of("token", header + "." + payload + "." + sig));
    }

    private static String clamp(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String b64(byte[] data) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(data);
    }
}
```

### .NET (ASP.NET Core, minimal API)

```csharp
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var app = WebApplication.CreateBuilder(args).Build();

static string B64(byte[] d) => Convert.ToBase64String(d).TrimEnd('=').Replace('+', '-').Replace('/', '_');

app.MapGet("/botcave/identity", (ClaimsPrincipal user, HttpResponse res) =>
{
    var id = user.FindFirstValue(ClaimTypes.NameIdentifier);   // id stabile dell'utente
    if (user.Identity?.IsAuthenticated != true || id is null) return Results.NoContent();

    var iat = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    var header = B64(JsonSerializer.SerializeToUtf8Bytes(new { alg = "HS256", typ = "JWT" }));
    // name/email facoltativi; string.Length conta unità UTF-16, come Botcave: oltre 100/254 il token sarebbe non valido
    static string Clamp(string s, int max) => s.Length <= max ? s : s.Substring(0, max);
    var name = user.FindFirstValue(ClaimTypes.Name);
    var email = user.FindFirstValue(ClaimTypes.Email);
    var claims = new Dictionary<string, object>
    {
        ["iss"] = Environment.GetEnvironmentVariable("BOTCAVE_APP")!,
        ["aud"] = "botcave",
        ["sub"] = id,
        ["iat"] = iat,
        ["exp"] = iat + 300,
    };
    if (!string.IsNullOrEmpty(name)) claims["name"] = Clamp(name, 100);
    if (!string.IsNullOrEmpty(email)) claims["email"] = Clamp(email, 254);
    var payload = B64(JsonSerializer.SerializeToUtf8Bytes(claims));
    var key = Encoding.UTF8.GetBytes(Environment.GetEnvironmentVariable("BOTCAVE_IDENTITY_SECRET")!); // stringa intera bci_...
    var sig = B64(HMACSHA256.HashData(key, Encoding.ASCII.GetBytes($"{header}.{payload}")));
    res.Headers.CacheControl = "no-store";
    return Results.Json(new { token = $"{header}.{payload}.{sig}" });
});

app.Run();
```

### Altri linguaggi

Basta un HMAC-SHA256 e il base64url senza padding: costruisci `base64url(header) + "." + base64url(payload)`, firma quella stringa
con la chiave, aggiungi `"." + base64url(firma)`.

## 5. Errori frequenti

| Sintomo | Causa |
|---|---|
| Pannello con «Questa app non è abilitata a Botcave» | l'origine non è in `EMBED_ALLOWED_ORIGINS` (su entrambi i container) |
| Avviso «data-identity-url ignorato» | percorso assoluto, `//…`, con `\` o caratteri di controllo, o più di 500 caratteri: usa `/botcave/identity` |
| Avviso «identità non ottenuta (HTTP 3xx/401/…)» | l'endpoint reindirizza o rifiuta: per l'utente non collegato rispondi `204` |
| Avviso «identità non ottenuta (risposta non valida)» | corpo non JSON, senza `token`, oppure token oltre 4 096 caratteri |
| «identità non valida» in «Prova identità» | segreto sbagliato o decodificato, `iss` diverso dallo slug, `aud` diverso da `botcave`, `alg` diverso da HS256, `exp` oltre `iat + 600` |
| «identità scaduta» | `exp` nel passato oltre i 60 secondi di tolleranza: controlla l'orologio del server |
| Le segnalazioni restano anonime | l'App non ha il segreto in Botcave, oppure l'endpoint risponde sempre `204` |

## 6. Lista di controllo di sicurezza

- [ ] La tua app e l'endpoint d'identità sono serviti **solo in HTTPS**.
- [ ] Il segreto `bci_…` sta **solo sul server** (variabile d'ambiente o gestore di segreti): mai nel codice del browser, in un
      repository, nei log o in un'immagine.
- [ ] L'endpoint risponde **solo a utenti con sessione valida** e usa il cookie della tua app; niente identità in base a parametri
      della richiesta.
- [ ] `exp` **breve**: 300 secondi o meno (il limite assoluto è 600); `iat` sempre l'ora del server.
- [ ] `sub` è un id **stabile e mai riutilizzato** (chiave primaria, non email o nome utente che possono cambiare o passare a un altro).
- [ ] Nei claim **niente dati sensibili**: `name` e `email` sono facoltativi, non metterci altro.
- [ ] `Cache-Control: no-store` sulla risposta; nessun log del token.
- [ ] Niente redirect dall'endpoint: `204` per chi non è collegato.
- [ ] Se il segreto è trapelato: «Rigenera» nella carta «Segnalazioni bug» (il vecchio smette di valere subito) e aggiorna il server.
- [ ] Rigenera il segreto anche quando chi ne era a conoscenza lascia il progetto.
