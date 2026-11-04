import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/table";
import { ago } from "../../lib/format";
import { gateApi, type GateAccount } from "../../lib/gate";
import { ModalActions, ResponsiveModal } from "../responsive-modal";
import { ErrorText, Loading, Unavailable } from "../ui";
import { ConfirmButton, KeyOnce, Submit, TabBar, TextField, useAction } from "./common";

/** Make a key, then show it once. The modal stays until the owner says they have it. */
function NewKey({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<string>();
  const close = () => {
    setOpen(false);
    setMade(undefined);
    setLabel("");
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden />
        New key
      </Button>
      <ResponsiveModal
        open={open}
        onOpenChange={(o) => (o ? setOpen(true) : close())}
        title={made ? "Copy your key" : "New key"}
        description={made ? undefined : "Name it after the agent that will use it."}
        locked={Boolean(made)}
      >
        {made ? (
          <>
            <KeyOnce apiKey={made} />
            <ModalActions>
              <Button onClick={close}>Done</Button>
            </ModalActions>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const key = await gateApi.createKey(session, account.id, label.trim());
                setMade(key.key);
                await queryClient.invalidateQueries({
                  queryKey: ["gate-keys", session, account.id],
                });
              });
            }}
          >
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              placeholder="Payables agent"
              mono={false}
            />
            <ErrorText error={action.error} />
            <ModalActions>
              <Button variant="ghost" type="button" onClick={close}>
                Cancel
              </Button>
              <Submit busy={action.busy}>Make key</Submit>
            </ModalActions>
          </form>
        )}
      </ResponsiveModal>
    </>
  );
}

/** The agents' API keys: make one (shown once) or revoke one. */
export function Keys({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ["gate-keys", session, account.id],
    queryFn: () => gateApi.keys(session, account.id),
    retry: false,
  });
  return (
    <div className="flex flex-col gap-5">
      <TabBar action={<NewKey account={account} session={session} />}>
        Your agents check payments with these. Revoking one stops it at once.
      </TabBar>
      {keys.error ? (
        <Unavailable error={keys.error} onRetry={() => void keys.refetch()} />
      ) : !keys.data ? (
        <Loading what="API keys" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Key</TableHead>
              <TableHead className="hidden md:table-cell">Label</TableHead>
              <TableHead className="hidden md:table-cell">Last used</TableHead>
              <TableHead>
                <span className="sr-only">Revoke</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.items.map((k) => (
              <TableRow key={k.id}>
                <TableCell>
                  <span className="font-mono text-[0.92em]">{k.prefix}…</span>
                  <span className="block text-muted md:hidden">
                    {k.label || "No label"} · {k.lastUsedAt ? ago(k.lastUsedAt) : "Never used"}
                  </span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {k.label || <span className="text-muted">None</span>}
                </TableCell>
                <TableCell className="hidden text-muted md:table-cell">
                  {k.lastUsedAt ? ago(k.lastUsedAt) : "Never"}
                </TableCell>
                <TableCell className="w-24 text-right">
                  {k.revokedAt ? (
                    <Badge variant="secondary">Revoked</Badge>
                  ) : (
                    <ConfirmButton
                      label="Revoke"
                      title={`Revoke ${k.label || k.prefix}?`}
                      description="Agents using this key stop working at once. This can't be undone."
                      confirm="Revoke key"
                      act={() => gateApi.revokeKey(session, account.id, k.id)}
                      then={() =>
                        queryClient.invalidateQueries({
                          queryKey: ["gate-keys", session, account.id],
                        })
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
