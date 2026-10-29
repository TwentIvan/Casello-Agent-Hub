import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown del modello (non fidato): react-markdown di default non interpreta HTML grezzo,
 * i link si aprono in un'altra scheda senza passare referrer né opener. Le immagini non si renderizzano:
 * caricherebbero da sole un indirizzo scelto dal modello (canale di esfiltrazione senza click).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
