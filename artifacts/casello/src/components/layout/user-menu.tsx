import { Link } from "wouter";
import { LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { getGetCurrentUserQueryKey, useGetCurrentUser, useLogout } from "@workspace/api-client-react";
import { BotcaveLogo } from "@/components/brand/marks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type ThemeChoice, useThemeChoice } from "@/lib/theme";

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "Come il sistema", icon: Monitor },
  { value: "light", label: "Chiaro", icon: Sun },
  { value: "dark", label: "Scuro", icon: Moon },
];

export function UserMenu() {
  const [theme, setTheme] = useThemeChoice();
  const { data: user } = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  // Ricarica completa dopo il logout: riparte da zero senza dati in cache.
  const logout = useLogout({ mutation: { onSettled: () => window.location.assign("/") } });

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* L'account è il logo stesso, nella versione chiara su scuro della barra della caverna */}
        <Button variant="ghost" className="h-auto rounded-sm px-1.5 py-1 hover:bg-ardesia" aria-label="Menu utente: account, tema, esci">
          <BotcaveLogo tone="dark" className="h-6" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{user.name ?? user.email}</div>
          {user.name && <div className="truncate text-xs text-muted-foreground">{user.email}</div>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRound />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-label text-ink-muted">Tema</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value} onSelect={(e) => e.preventDefault()}>
              <t.icon />
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate()}>
          <LogOut />
          Esci
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
