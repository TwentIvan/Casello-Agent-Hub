import { CatalogNews } from "@/components/catalog/catalog-news";
import { CatalogTable } from "@/components/catalog/catalog-table";

export default function ModelsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Modelli</h2>
        <p className="text-sm text-muted-foreground">Il catalogo dei modelli dei provider e le sue novità.</p>
      </div>
      <CatalogNews />
      <CatalogTable />
    </div>
  );
}
