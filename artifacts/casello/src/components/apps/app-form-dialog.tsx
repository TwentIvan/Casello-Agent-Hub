import { useState, type ReactNode } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  getGetDashboardStatsQueryKey,
  getListAppsQueryKey,
  useCreateApp,
  useUpdateApp,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const appFormSchema = z.object({
  name: z.string().trim().min(1, "Il nome è obbligatorio."),
  description: z.string().trim(),
  baseUrl: z.string().trim().url("Inserisci un URL completo, es. https://mister.example.com."),
  status: z.enum(["active", "inactive"]),
  internalBaseUrl: z.string().trim().refine((v) => v === "" || URL.canParse(v), "Inserisci un URL completo, es. http://mister:3000."),
  userAuthEnabled: z.boolean(),
  userAuthHeader: z.string().trim(),
  userAuthScheme: z.string().trim(),
  serviceAuthEnabled: z.boolean(),
  serviceAuthHeader: z.string().trim(),
  serviceAuthScheme: z.string().trim(),
  serviceSecret: z.string(),
}).superRefine((v, ctx) => {
  if (v.userAuthEnabled && !v.userAuthHeader) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["userAuthHeader"], message: "L'header è obbligatorio." });
  }
  if (v.serviceAuthEnabled && !v.serviceAuthHeader) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["serviceAuthHeader"], message: "L'header è obbligatorio." });
  }
});

type AppFormValues = z.infer<typeof appFormSchema>;

function AuthFields({
  form,
  prefix,
  title,
  hint,
  onDisable,
  children,
}: {
  form: UseFormReturn<AppFormValues>;
  prefix: "user" | "service";
  title: string;
  hint: string;
  onDisable?: () => void;
  children?: ReactNode;
}) {
  const enabled = form.watch(`${prefix}AuthEnabled`);
  return (
    <div className="space-y-3 rounded-md border p-3">
      <FormField
        control={form.control}
        name={`${prefix}AuthEnabled`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between gap-3 space-y-0">
            <div>
              <FormLabel>{title}</FormLabel>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked);
                  if (!checked) onDisable?.();
                }}
                aria-label={title}
              />
            </FormControl>
          </FormItem>
        )}
      />
      {enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              control={form.control}
              name={`${prefix}AuthHeader`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Header</FormLabel>
                  <FormControl>
                    <Input className="font-mono" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`${prefix}AuthScheme`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schema</FormLabel>
                  <FormControl>
                    <Input className="font-mono" placeholder="Vuoto = valore grezzo" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {children}
        </>
      )}
    </div>
  );
}

interface AppFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** App da modificare; assente per crearne una nuova. */
  app?: App;
}

export function AppFormDialog({ open, onOpenChange, app }: AppFormDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Il segreto non torna mai dall'API: resta invariato salvo nuovo valore o rimozione esplicita.
  const [clearSecret, setClearSecret] = useState(false);
  const secretSet = app?.serviceSecretSet === true && !clearSecret;
  const form = useForm<AppFormValues>({
    resolver: zodResolver(appFormSchema),
    defaultValues: {
      name: app?.name ?? "",
      description: app?.description ?? "",
      baseUrl: app?.baseUrl ?? "",
      status: app?.status ?? "active",
      internalBaseUrl: app?.internalBaseUrl ?? "",
      userAuthEnabled: app ? Boolean(app.userAuth) : true,
      userAuthHeader: app?.userAuth?.header ?? "Authorization",
      userAuthScheme: app ? (app.userAuth?.scheme ?? "") : "Bearer",
      serviceAuthEnabled: Boolean(app?.serviceAuth),
      serviceAuthHeader: app?.serviceAuth?.header ?? "Authorization",
      serviceAuthScheme: app ? (app.serviceAuth?.scheme ?? "") : "Bearer",
      serviceSecret: "",
    },
  });

  const onSuccess = (saved: App) => {
    void queryClient.invalidateQueries({ queryKey: getListAppsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    toast({ title: app ? "App aggiornata" : "App creata", description: saved.name });
    onOpenChange(false);
  };
  const onError = (error: unknown) =>
    toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) });

  const createApp = useCreateApp({ mutation: { onSuccess, onError } });
  const updateApp = useUpdateApp({ mutation: { onSuccess, onError } });
  const saving = createApp.isPending || updateApp.isPending;

  const onSubmit = (values: AppFormValues) => {
    const { userAuthEnabled, userAuthHeader, userAuthScheme, serviceAuthEnabled, serviceAuthHeader, serviceAuthScheme, serviceSecret, ...rest } = values;
    const common = {
      name: rest.name,
      baseUrl: rest.baseUrl,
      status: rest.status,
      internalBaseUrl: rest.internalBaseUrl || null,
      userAuth: userAuthEnabled ? { header: userAuthHeader, scheme: userAuthScheme || null } : null,
      serviceAuth: serviceAuthEnabled ? { header: serviceAuthHeader, scheme: serviceAuthScheme || null } : null,
    };
    if (app) {
      // Segreto: inviato solo se digitato o rimosso; altrimenti resta quello salvato.
      // Con l'auth di servizio spenta il segreto salvato va cancellato; un valore digitato non si invia mai.
      const secret = !serviceAuthEnabled
        ? app.serviceSecretSet
          ? { serviceSecret: null }
          : {}
        : serviceSecret
          ? { serviceSecret }
          : clearSecret
            ? { serviceSecret: null }
            : {};
      updateApp.mutate({ id: app.id, data: { ...common, description: rest.description || null, ...secret } });
    } else {
      createApp.mutate({
        data: { ...common, description: rest.description || undefined, ...(serviceAuthEnabled && serviceSecret ? { serviceSecret } : {}) },
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{app ? "Modifica app" : "Nuova app"}</DialogTitle>
          <DialogDescription>L'applicazione che i suoi agenti potranno chiamare tramite i propri strumenti.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input placeholder="es. Mister" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Descrizione</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="Facoltativa" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="baseUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Base URL</FormLabel>
                  <FormControl>
                    <Input placeholder="es. https://mister.example.com" inputMode="url" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stato</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="active">Attiva</SelectItem>
                      <SelectItem value="inactive">Inattiva</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-4 border-t pt-4">
              <div>
                <h3 className="text-sm font-medium">Collegamento</h3>
                <p className="text-xs text-muted-foreground">Come gli agenti raggiungono l'app e si autenticano.</p>
              </div>
              <FormField
                control={form.control}
                name="internalBaseUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Indirizzo interno</FormLabel>
                    <FormControl>
                      <Input placeholder="Facoltativo, es. http://mister:3000/api" inputMode="url" {...field} />
                    </FormControl>
                    <FormDescription>Se presente, le chiamate dei tool partono da qui invece che dalla base URL.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AuthFields form={form} prefix="user" title="Autenticazione utente" hint="Il token dell'utente viene inoltrato all'app." />
              <AuthFields
                form={form}
                prefix="service"
                onDisable={() => {
                  form.setValue("serviceSecret", "");
                  setClearSecret(false);
                }} title="Autenticazione di servizio" hint="Credenziale propria di Casello, per i tool con identità di servizio.">
                <FormField
                  control={form.control}
                  name="serviceSecret"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Segreto</FormLabel>
                      <div className="flex items-center gap-2">
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            placeholder={secretSet ? "Impostato (lascia vuoto per non cambiarlo)" : "Non impostato"}
                            {...field}
                          />
                        </FormControl>
                        {secretSet && (
                          <Button type="button" variant="outline" size="sm" onClick={() => setClearSecret(true)}>
                            Rimuovi
                          </Button>
                        )}
                      </div>
                      {clearSecret && app?.serviceSecretSet && !field.value && (
                        <FormDescription>
                          Il segreto verrà cancellato al salvataggio.{" "}
                          <button type="button" className="underline" onClick={() => setClearSecret(false)}>
                            Annulla rimozione
                          </button>
                        </FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </AuthFields>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annulla
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Salvataggio…" : app ? "Salva" : "Crea app"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
