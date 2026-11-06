import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Bot, Cpu, LayoutDashboard, PlayCircle, Boxes, ShieldCheck, Sparkles, LayoutTemplate, Users, Mic, type LucideIcon } from "lucide-react";
import {
  getGetDashboardStatsQueryKey,
  getListUnreadTeamEventsQueryKey,
  useGetDashboardStats,
  useListUnreadTeamEvents,
} from "@workspace/api-client-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { BudgetGuard } from "@/components/budget/budget";
import { CaveVault } from "@/components/brand/cave";
import { Button } from "@/components/ui/button";
import { UserMenu } from "./user-menu";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Un solo elenco: le aree non servono a orientarsi. Alfred non è una voce di menu: si chiama dalla barra in alto.
const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/teams", label: "Squadre", icon: Users },
  { href: "/pending-actions", label: "Da confermare", icon: ShieldCheck },
  { href: "/runs", label: "Run", icon: PlayCircle },
  { href: "/apps", label: "App", icon: Boxes },
  { href: "/agents", label: "Agenti", icon: Bot },
  { href: "/skills", label: "Skill", icon: Sparkles },
  { href: "/team-templates", label: "Modelli di squadra", icon: LayoutTemplate },
  { href: "/models", label: "Modelli AI", icon: Cpu },
];

function isActive(href: string, location: string): boolean {
  return href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
}

const UNREAD = { unread: true } as const;

function NavMenu({ location, items }: { location: string; items: NavItem[] }) {
  const { setOpenMobile } = useSidebar();
  // Contatore delle azioni in attesa: si riallinea ogni 30 s e quando si torna sulla finestra.
  const stats = useGetDashboardStats({ query: { queryKey: getGetDashboardStatsQueryKey(), refetchInterval: 30_000 } });
  const pending = stats.data?.pendingActions ?? 0;
  // Notizie non lette del bollettino delle squadre attivate dall'utente
  const events = useListUnreadTeamEvents(UNREAD, {
    query: { queryKey: getListUnreadTeamEventsQueryKey(UNREAD), refetchInterval: 30_000 },
  });
  const unread = events.data?.length ?? 0;

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton asChild isActive={isActive(item.href, location)} tooltip={item.label}>
            {/* Su mobile la sidebar è un pannello sovrapposto: va chiusa dopo la scelta */}
            <Link href={item.href} onClick={() => setOpenMobile(false)}>
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
          {item.href === "/pending-actions" && pending > 0 && (
            <SidebarMenuBadge className="rounded-none bg-brand font-mono text-on-brand" title={`${pending} voci da confermare`}>
              {pending}
            </SidebarMenuBadge>
          )}
          {item.href === "/teams" && unread > 0 && (
            <SidebarMenuBadge className="font-mono text-accent-text" title={`${unread} notizie non lette nel bollettino`}>
              {unread}
            </SidebarMenuBadge>
          )}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/*
 * Barra in alto: la volta della caverna (stalattiti sul buio e LED ambra), sotto il logo chiaro su scuro, che apre il
 * menu dell'account, e a destra il microfono per parlare con Alfred. È buia in entrambi i temi, come la copertina del
 * manuale.
 */
function CaveHeader() {
  return (
    <header className="relative flex h-28 shrink-0 flex-col overflow-hidden bg-notte">
      <div aria-hidden="true" className="h-16 shrink-0">
        <CaveVault />
      </div>
      <div className="flex min-h-0 flex-1 items-center gap-3 pl-4 pr-4 sm:pr-6">
        <SidebarTrigger className="-ml-1 text-nebbia hover:bg-ardesia hover:text-nebbia" />
        <UserMenu />
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="ml-auto text-nebbia hover:bg-ardesia hover:text-nebbia"
          aria-label="Parla con Alfred"
          title="Parla con Alfred"
        >
          <Link href="/alfred">
            <Mic />
          </Link>
        </Button>
      </div>
      {/* Il pavimento di roccia */}
      <div aria-hidden="true" className="h-1.5 shrink-0 bg-ardesia" />
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <NavMenu location={location} items={NAV_ITEMS} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <CaveHeader />
        <main className="flex-1 p-4 md:p-6">{children}</main>
        <BudgetGuard />
      </SidebarInset>
    </SidebarProvider>
  );
}
