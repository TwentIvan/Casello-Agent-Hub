import { Fragment, type ReactNode } from "react";
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
  SidebarHeader,
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
import { AlfredMark, BotcaveLogo, BotcaveMark, LuciusMark } from "@/components/brand/marks";
import { CaveDivider, CaveVault } from "@/components/brand/cave";
import { UserMenu } from "./user-menu";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/*
 * Due aree, separate nel menu solo da un elemento grafico (le stalattiti), senza titoli:
 * - quartier generale: dirigere il lavoro delle squadre e decidere (il regno di Alfred);
 * - officina: analizzare e migliorare le applicazioni e costruire agenti, skill e squadre (il laboratorio di Lucius).
 * I nomi restano per i lettori di schermo.
 */
interface NavArea {
  key: "hq" | "workshop";
  title: string;
  items: NavItem[];
}

const NAV_AREAS: NavArea[] = [
  {
    key: "hq",
    title: "Quartier generale",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/teams", label: "Squadre", icon: Users },
      { href: "/pending-actions", label: "Da confermare", icon: ShieldCheck },
      { href: "/runs", label: "Run", icon: PlayCircle },
      { href: "/alfred", label: "Parla con Alfred", icon: Mic },
    ],
  },
  {
    key: "workshop",
    title: "Officina",
    items: [
      { href: "/apps", label: "App", icon: Boxes },
      { href: "/agents", label: "Agenti", icon: Bot },
      { href: "/skills", label: "Skill", icon: Sparkles },
      { href: "/team-templates", label: "Modelli di squadra", icon: LayoutTemplate },
      { href: "/models", label: "Modelli AI", icon: Cpu },
    ],
  },
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
 * Chi abita l'area aperta: Alfred nel quartier generale, Lucius nell'officina. Le pagine fuori dal menu (Account)
 * non hanno un padrone di casa.
 */
const AREA_HOSTS: Record<NavArea["key"], { name: string; area: string }> = {
  hq: { name: "Alfred", area: "quartier generale" },
  workshop: { name: "Lucius", area: "officina" },
};

function currentArea(location: string): NavArea["key"] | null {
  return NAV_AREAS.find((area) => area.items.some((item) => isActive(item.href, location)))?.key ?? null;
}

/*
 * Barra in alto: la volta della caverna (stalattiti sul buio e LED ambra), sotto il padrone di casa dell'area con il
 * suo segno, a destra l'account. È buia in entrambi i temi, come la copertina del manuale.
 */
function CaveHeader({ location }: { location: string }) {
  const area = currentArea(location);
  const host = area ? AREA_HOSTS[area] : null;
  return (
    <header className="relative flex h-28 shrink-0 flex-col overflow-hidden bg-notte">
      <div aria-hidden="true" className="h-16 shrink-0">
        <CaveVault />
      </div>
      <div className="flex min-h-0 flex-1 items-center gap-3 pl-4 pr-4 sm:pr-6">
        <SidebarTrigger className="-ml-1 text-nebbia hover:bg-ardesia hover:text-nebbia" />
        {host && (
          <p className="flex items-center gap-2 text-label uppercase text-roccia" title={`${host.name}, ${host.area}`}>
            {area === "hq" ? <AlfredMark size={16} tone="dark" /> : <LuciusMark size={16} tone="dark" />}
            <span className="text-nebbia">{host.name}</span>
            <span aria-hidden="true">·</span>
            <span>{host.area}</span>
          </p>
        )}
        <div className="ml-auto">
          <UserMenu />
        </div>
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
        <SidebarHeader>
          {/* Logo orizzontale (oltre 96 px); con la barra chiusa a icone solo il segno */}
          <Link href="/" className="flex items-center px-2 py-2" aria-label="Botcave, vai alla dashboard">
            <span className="flex group-data-[collapsible=icon]:hidden">
              <BotcaveLogo className="h-6" />
            </span>
            <span className="hidden group-data-[collapsible=icon]:flex">
              <BotcaveMark className="h-4" />
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {NAV_AREAS.map((area, index) => (
            <Fragment key={area.key}>
              {index > 0 && <CaveDivider />}
              <SidebarGroup aria-label={area.title}>
                <SidebarGroupContent>
                  <NavMenu location={location} items={area.items} />
                </SidebarGroupContent>
              </SidebarGroup>
            </Fragment>
          ))}
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <CaveHeader location={location} />
        <main className="flex-1 p-4 md:p-6">{children}</main>
        <BudgetGuard />
      </SidebarInset>
    </SidebarProvider>
  );
}
