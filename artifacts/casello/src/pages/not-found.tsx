import { Link } from "wouter";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <FileQuestion className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Pagina non trovata</h2>
        <p className="text-sm text-muted-foreground">L'indirizzo che hai aperto non esiste.</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/">Torna alla dashboard</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
