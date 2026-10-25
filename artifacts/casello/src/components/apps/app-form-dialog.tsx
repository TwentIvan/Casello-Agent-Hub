import { useForm } from "react-hook-form";
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const appFormSchema = z.object({
  name: z.string().trim().min(1, "Il nome è obbligatorio."),
  description: z.string().trim(),
  baseUrl: z.string().trim().url("Inserisci un URL completo, es. https://mister.example.com."),
  status: z.enum(["active", "inactive"]),
});

type AppFormValues = z.infer<typeof appFormSchema>;

interface AppFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** App da modificare; assente per crearne una nuova. */
  app?: App;
}

export function AppFormDialog({ open, onOpenChange, app }: AppFormDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<AppFormValues>({
    resolver: zodResolver(appFormSchema),
    defaultValues: {
      name: app?.name ?? "",
      description: app?.description ?? "",
      baseUrl: app?.baseUrl ?? "",
      status: app?.status ?? "active",
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
    if (app) {
      updateApp.mutate({ id: app.id, data: { ...values, description: values.description || null } });
    } else {
      createApp.mutate({ data: { ...values, description: values.description || undefined } });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
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
