import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AtSign,
  Asterisk,
  BadgeCheck,
  Banknote,
  BookLock,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  FileKey2,
  Fingerprint,
  Globe,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  categoryLabels,
  categories,
  secretLabels,
  type Category,
  type CustomField,
  type ItemDraft,
  type VaultItem,
} from "./types";
import {
  createUnlockFactors,
  createTotpSecret,
  createVault,
  parseEncryptedVault,
  sealVault,
  totpUri,
  unlockVault,
  verifyTotp,
  type EncryptedVault,
  type UnlockFactors,
  type VaultSession,
} from "./vault";

const AUTO_LOCK_AFTER = 5 * 60 * 1000;

function useDialogFocus(onClose: () => void, busy: boolean) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0);
    const focusInside = () => (focusable().find((element) => element.matches("input")) ?? focusable()[0] ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) focusInside();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first || !last) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInside();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      const previous = previousFocus.current;
      if (previous?.isConnected && previous.getClientRects().length && getComputedStyle(previous).visibility !== "hidden") {
        previous.focus();
      } else {
        const menuButton = document.querySelector<HTMLElement>(".mobile-menu-open");
        if (menuButton?.getClientRects().length) menuButton.focus();
      }
    };
  }, []);

  return dialogRef;
}

const categoryIcons: Record<Category, typeof KeyRound> = {
  login: KeyRound,
  card: Banknote,
  identity: Fingerprint,
  "secure-note": BookLock,
  "api-key": AtSign,
  "ssh-key": FileKey2,
  wifi: Wifi,
  other: Asterisk,
};

const emptyDraft = (): ItemDraft => ({
  title: "",
  category: "login",
  username: "",
  secret: "",
  url: "",
  notes: "",
  tags: "",
  customFields: [],
});

interface VaultSetupDraft {
  password: string;
  items: VaultItem[];
  factors: UnlockFactors;
  migrating: boolean;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );
}

function generatePassword(length = 20): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*()-_=+";
  const limit = Math.floor(0x1_0000_0000 / alphabet.length) * alphabet.length;
  let password = "";
  while (password.length < length) {
    const values = crypto.getRandomValues(new Uint32Array(length - password.length + 8));
    for (const value of values) {
      if (value >= limit) continue;
      password += alphabet[value % alphabet.length];
      if (password.length === length) break;
    }
  }
  return password;
}

function App() {
  const [vaultText, setVaultText] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [encryptedEnvelope, setEncryptedEnvelope] = useState<EncryptedVault | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [setupDraft, setSetupDraft] = useState<VaultSetupDraft | null>(null);
  const [authenticatorSecret, setAuthenticatorSecret] = useState<string | null>(null);
  const [authenticatorError, setAuthenticatorError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<Category | "all" | "favorites">("all");
  const [sortMode, setSortMode] = useState<"recent" | "title">("recent");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<VaultItem | null | undefined>(undefined);
  const [toast, setToast] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuCloseRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const lastActivityRef = useRef(Date.now());
  const toastTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<VaultSession | null>(null);

  const isUnlocked = session !== null;
  const isFirstRun = storageReady && vaultText === null;

  useEffect(() => {
    let active = true;
    invoke<string | null>("read_vault")
      .then((stored) => {
        if (!active) return;
        setVaultText(stored);
        if (stored) {
          try {
            setEncryptedEnvelope(parseEncryptedVault(stored));
          } catch (error) {
            setStorageError(error instanceof Error ? error.message : "The vault file could not be read.");
          }
        }
        setStorageReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStorageError(error instanceof Error ? error.message : String(error));
        setStorageReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const lockVault = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
    setItems([]);
    setSelectedId(null);
    setEditingItem(undefined);
    setShowSecret(false);
    setMasterPassword("");
    setConfirmPassword("");
    setAuthenticatorSecret(null);
    setAuthenticatorError("");
    setQuery("");
    setIsMenuOpen(false);
    setToast("");
  }, []);

  useEffect(() => {
    if (!isUnlocked) return;
    const markActive = () => {
      lastActivityRef.current = Date.now();
    };
    const checkIdle = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current >= AUTO_LOCK_AFTER) lockVault();
    }, 15_000);
    window.addEventListener("pointerdown", markActive);
    window.addEventListener("keydown", markActive);
    window.addEventListener("mousemove", markActive);
    return () => {
      window.clearInterval(checkIdle);
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("mousemove", markActive);
    };
  }, [isUnlocked, lockVault]);

  useEffect(() => {
    if (!toast) return;
    toastTimerRef.current = window.setTimeout(() => setToast(""), 3200);
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, [toast]);

  useEffect(() => {
    if (isMenuOpen && window.matchMedia("(max-width: 850px)").matches) menuCloseRef.current?.focus();
  }, [isMenuOpen]);

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      const shortcut = event.metaKey || event.ctrlKey;
      const modalOpen = editingItem !== undefined || authenticatorSecret !== null;
      if (shortcut && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!modalOpen) searchRef.current?.focus();
      }
      if (shortcut && event.key.toLowerCase() === "n" && isUnlocked) {
        event.preventDefault();
        if (!busy && !modalOpen) setEditingItem(null);
      }
      if (shortcut && event.key.toLowerCase() === "l" && isUnlocked) {
        event.preventDefault();
        lockVault();
      }
      if (event.key === "Escape") {
        setEditingItem(undefined);
        setIsMenuOpen(false);
        if (isMenuOpen && window.matchMedia("(max-width: 850px)").matches) menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [isUnlocked, lockVault, busy, editingItem, authenticatorSecret, isMenuOpen]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items
      .filter((item) => {
        if (categoryFilter === "favorites" && !item.favorite) return false;
        if (categoryFilter !== "all" && categoryFilter !== "favorites" && item.category !== categoryFilter) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [
          item.title,
          item.username,
          item.url,
          item.notes,
          ...item.tags,
          ...item.customFields.flatMap((field) => [field.label, field.value]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((a, b) => {
        const favoriteOrder = Number(b.favorite) - Number(a.favorite);
        if (favoriteOrder) return favoriteOrder;
        return sortMode === "recent" ? b.updatedAt.localeCompare(a.updatedAt) : a.title.localeCompare(b.title);
      });
  }, [items, query, categoryFilter, sortMode]);

  useEffect(() => {
    if (!filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0]?.id ?? null);
    }
  }, [filteredItems, selectedId]);

  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(categories.map((category) => [category, 0])) as Record<Category, number>;
    items.forEach((item) => {
      counts[item.category] += 1;
    });
    return counts;
  }, [items]);

  const showToast = (message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
    if (window.matchMedia("(max-width: 850px)").matches) menuButtonRef.current?.focus();
  };

  const selectCategory = (category: Category | "all" | "favorites") => {
    setCategoryFilter(category);
    closeMenu();
  };

  const persist = async (activeSession: VaultSession, nextItems: VaultItem[]) => {
    const envelope = await sealVault(activeSession, nextItems);
    const serialized = JSON.stringify(envelope);
    await invoke("write_vault", { contents: serialized });
    setEncryptedEnvelope(envelope);
    setVaultText(serialized);
    if (sessionRef.current === activeSession) setItems(nextItems);
  };

  const handleCreateVault = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");
    if (masterPassword.length < 12) {
      setAuthError("Use at least 12 characters for your master password.");
      return;
    }
    if (masterPassword !== confirmPassword) {
      setAuthError("The passwords do not match.");
      return;
    }
    setSetupDraft({
      password: masterPassword,
      items: [],
      factors: createUnlockFactors(),
      migrating: false,
    });
    setMasterPassword("");
    setConfirmPassword("");
  };

  const handleCompleteSetup = async (draft: VaultSetupDraft) => {
    setBusy(true);
    setAuthError("");
    try {
      const created = await createVault(draft.password, draft.items, draft.factors);
      await invoke("store_unlock_factors", {
        vaultId: draft.factors.vaultId,
        deviceKey: draft.factors.deviceKey,
        totpSecret: draft.factors.totpSecret,
      });
      const serialized = JSON.stringify(created.envelope);
      await invoke("write_vault", { contents: serialized });
      setVaultText(serialized);
      setEncryptedEnvelope(created.envelope);
      setItems(draft.items);
      sessionRef.current = created.session;
      setSession(created.session);
      setSetupDraft(null);
      setMasterPassword("");
      setConfirmPassword("");
      setTotpCode("");
      lastActivityRef.current = Date.now();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const beginAuthenticatorChange = () => {
    if (session?.version !== 2) {
      showToast("Unlock a supported vault before changing its authenticator.");
      return;
    }
    setAuthenticatorSecret(createTotpSecret());
    setAuthenticatorError("");
    setIsMenuOpen(false);
  };

  const handleReplaceAuthenticator = async (code: string) => {
    const activeSession = sessionRef.current;
    const newSecret = authenticatorSecret;
    setBusy(true);
    setAuthenticatorError("");
    try {
      if (!activeSession || activeSession.version !== 2 || !newSecret) {
        throw new Error("Unlock the vault again before changing its authenticator.");
      }
      if (!(await verifyTotp(newSecret, code))) {
        throw new Error("That code did not match. Check the new authenticator entry and try its current code.");
      }
      if (sessionRef.current !== activeSession) {
        throw new Error("The vault was locked before the authenticator could be changed.");
      }
      await invoke("update_totp_secret", {
        vaultId: activeSession.vaultId,
        totpSecret: newSecret,
      });
      setAuthenticatorSecret(null);
      showToast("Authenticator changed. Use the new authenticator next time you unlock.");
    } catch (error) {
      setAuthenticatorError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!vaultText) return;
    setBusy(true);
    setAuthError("");
    try {
      const envelope = parseEncryptedVault(vaultText);
      if (envelope.version === 1) {
        const unlocked = await unlockVault(vaultText, masterPassword);
        setSetupDraft({
          password: masterPassword,
          items: unlocked.items,
          factors: createUnlockFactors(),
          migrating: true,
        });
        setMasterPassword("");
        return;
      }

      const factors = await invoke<{ deviceKey: string; totpSecret: string } | null>("read_unlock_factors", {
        vaultId: envelope.vaultId,
      });
      if (!factors) {
        throw new Error("This vault's device key is missing from the OS credential store.");
      }
      if (!(await verifyTotp(factors.totpSecret, totpCode))) {
        throw new Error("The authenticator code is incorrect or expired.");
      }

      const unlocked = await unlockVault(vaultText, masterPassword, factors.deviceKey);
      sessionRef.current = unlocked.session;
      setSession(unlocked.session);
      setItems(unlocked.items);
      setEncryptedEnvelope(unlocked.envelope);
      setMasterPassword("");
      lastActivityRef.current = Date.now();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setTotpCode("");
    }
  };

  const handleSaveItem = async (draft: ItemDraft) => {
    if (!session || busy) return;
    const now = new Date().toISOString();
    const existing = editingItem ?? null;
    const item: VaultItem = {
      id: existing?.id ?? crypto.randomUUID(),
      title: draft.title.trim(),
      category: draft.category,
      username: draft.username.trim(),
      secret: draft.secret,
      url: draft.url.trim(),
      notes: draft.notes,
      tags: draft.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      favorite: existing?.favorite ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      customFields: draft.customFields.filter((field) => field.label.trim() || field.value),
    };
    const nextItems = existing
      ? items.map((current) => (current.id === existing.id ? item : current))
      : [...items, item];
    setBusy(true);
    try {
      await persist(session, nextItems);
      if (sessionRef.current !== session) return;
      setQuery("");
      setCategoryFilter("all");
      setSelectedId(item.id);
      setEditingItem(undefined);
      showToast(existing ? "Changes saved" : "Item added to your vault");
    } catch (error) {
      showToast(error instanceof Error ? `Could not save: ${error.message}` : "Could not save this item.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteItem = async (item: VaultItem) => {
    if (!session || busy || !window.confirm(`Permanently delete "${item.title}" from your vault?`)) return;
    const nextItems = items.filter((current) => current.id !== item.id);
    setBusy(true);
    try {
      await persist(session, nextItems);
      if (sessionRef.current !== session) return;
      setSelectedId(nextItems[0]?.id ?? null);
      showToast("Item deleted");
    } catch (error) {
      showToast(error instanceof Error ? `Could not delete: ${error.message}` : "Could not delete this item.");
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = async (item: VaultItem) => {
    if (!session || busy) return;
    const nextItems = items.map((current) =>
      current.id === item.id ? { ...current, favorite: !current.favorite, updatedAt: new Date().toISOString() } : current,
    );
    setBusy(true);
    try {
      await persist(session, nextItems);
      if (sessionRef.current !== session) return;
    } catch (error) {
      showToast(error instanceof Error ? `Could not save: ${error.message}` : "Could not save this change.");
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async (value: string, label: string) => {
    if (!value) {
      showToast(`No ${label.toLowerCase()} to copy`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${label} copied. It will be cleared in 30 seconds if unchanged.`);
      window.setTimeout(async () => {
        try {
          if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText("");
        } catch {
          showToast("Clipboard auto-clear was blocked. Clear the copied value manually.");
        }
      }, 30_000);
    } catch {
      showToast("Clipboard access was denied. Copy the value manually.");
    }
  };

  const exportBackup = () => {
    if (!encryptedEnvelope || busy) return;
    const blob = new Blob([JSON.stringify(encryptedEnvelope, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `personal-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setIsMenuOpen(false);
    showToast("Encrypted backup exported");
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setAuthError("");
    try {
      const contents = await file.text();
      const envelope = parseEncryptedVault(contents);
      if (envelope.version === 2) {
        const factors = await invoke<{ deviceKey: string; totpSecret: string } | null>("read_unlock_factors", {
          vaultId: envelope.vaultId,
        });
        if (!factors) {
          throw new Error("This backup is not linked to this device's OS credential store.");
        }
      }
      const serialized = JSON.stringify(envelope);
      await invoke("write_vault", { contents: serialized });
      setVaultText(serialized);
      setEncryptedEnvelope(envelope);
      sessionRef.current = null;
      setSession(null);
      setItems([]);
      setAuthError("");
      showToast("Backup restored. Unlock it with its master password.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAuthError(message);
      showToast("Could not restore this backup");
    } finally {
      setBusy(false);
    }
  };

  if (!storageReady) {
    return (
      <main className="loading-screen">
        <div className="brand-mark"><ShieldCheck size={25} /></div>
        <div className="loading-dots"><span /><span /><span /></div>
        <p>Opening your vault…</p>
      </main>
    );
  }

  if (!isUnlocked) {
    return (
      <main className="auth-screen">
        <div className="auth-topline">
          <div className="brand-lockup">
            <div className="brand-mark"><ShieldCheck size={22} strokeWidth={2.2} /></div>
            <span>personal<span className="brand-light">vault</span></span>
          </div>
          <span className="local-badge"><span /> Stored on this device</span>
        </div>

        <div className="auth-content">
          <div className="auth-art">
            <div className="art-glow" />
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-shield"><Shield size={82} strokeWidth={1.1} /><LockKeyhole size={29} /></div>
            <div className="floating-chip chip-one"><KeyRound size={15} /> <span>Passwords</span></div>
            <div className="floating-chip chip-two"><CreditCardIcon /> <span>Cards & IDs</span></div>
            <div className="floating-chip chip-three"><FileKey2 size={15} /> <span>Private keys</span></div>
          </div>
          <section className="auth-card">
            <div className="auth-icon"><LockKeyhole size={21} /></div>
            {setupDraft ? (
              <FactorEnrollment
                setup={setupDraft}
                busy={busy}
                error={authError}
                onCancel={() => {
                  setSetupDraft(null);
                  setAuthError("");
                }}
                onComplete={handleCompleteSetup}
              />
            ) : isFirstRun ? (
              <>
                <p className="eyebrow">THREE-FACTOR SECURITY</p>
                <h1>Create your vault</h1>
                <p className="auth-subtitle">
                  Protect your vault with a master password, an authenticator, and this device.
                </p>
                <form className="auth-form" onSubmit={handleCreateVault}>
                  <label htmlFor="master-password">Master password</label>
                  <input
                    id="master-password"
                    type="password"
                    autoComplete="new-password"
                    value={masterPassword}
                    onChange={(event) => setMasterPassword(event.target.value)}
                    placeholder="At least 12 characters"
                    minLength={12}
                    required
                    autoFocus
                  />
                  <label htmlFor="confirm-password">Confirm password</label>
                  <input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Enter it one more time"
                    minLength={12}
                    required
                  />
                  <PasswordGuidance />
                  {(authError || storageError) && <p className="form-error" role="alert">{authError || storageError}</p>}
                  <button className="primary-button auth-submit" type="submit" disabled={busy || Boolean(storageError)}>
                    Continue to security setup <ArrowRight size={16} />
                  </button>
                </form>
              </>
            ) : (
              <>
                <p className="eyebrow">WELCOME BACK</p>
                <h1>Your vault awaits</h1>
                <p className="auth-subtitle">Use your master password, authenticator code, and this device.</p>
                <form className="auth-form" onSubmit={handleUnlock}>
                  <label htmlFor="master-password">Master password</label>
                  <input
                    id="master-password"
                    type="password"
                    autoComplete="current-password"
                    value={masterPassword}
                    onChange={(event) => setMasterPassword(event.target.value)}
                    placeholder="Enter your master password"
                    required
                    autoFocus
                  />
                  {encryptedEnvelope?.version === 2 ? (
                    <>
                      <label htmlFor="authenticator-code">Authenticator code</label>
                      <input
                        id="authenticator-code"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9 ]{6,8}"
                        maxLength={8}
                        value={totpCode}
                        onChange={(event) => setTotpCode(event.target.value.replace(/[^0-9 ]/g, ""))}
                        placeholder="6-digit code"
                        required
                      />
                      <p className="auth-factor-hint">The device key is read from your OS credential store.</p>
                    </>
                  ) : encryptedEnvelope?.version === 1 ? (
                    <p className="auth-factor-hint">This older vault will be upgraded to three-factor protection after unlock.</p>
                  ) : null}
                  {(authError || storageError) && <p className="form-error" role="alert">{authError || storageError}</p>}
                  <button className="primary-button auth-submit" type="submit" disabled={busy || Boolean(storageError)}>
                    {busy ? "Verifying factors…" : "Unlock vault"} <ArrowRight size={16} />
                  </button>
                  <button className="text-button restore-link" type="button" onClick={() => importRef.current?.click()}>
                    <ArrowDownToLine size={15} /> Restore from encrypted backup
                  </button>
                  <input ref={importRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={importBackup} />
                </form>
              </>
            )}
            <div className="auth-security"><ShieldCheck size={16} /> AES-256 encryption + device key</div>
          </section>
        </div>
        <footer className="auth-footer"><span>Personal Vault</span><span>Private by design. Yours alone.</span></footer>
      </main>
    );
  }

  const heading = categoryFilter === "all" ? "All items" : categoryFilter === "favorites" ? "Favorites" : categoryLabels[categoryFilter];
  const selectedCount = categoryFilter === "all" ? items.length : filteredItems.length;

  return (
    <main className="app-shell">
      <aside id="vault-sidebar" className={`sidebar ${isMenuOpen ? "sidebar-open" : ""}`} aria-label="Vault navigation">
        <div className="sidebar-brand">
          <div className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></div>
          <div><strong>personal<span>vault</span></strong><small>YOUR PRIVATE SPACE</small></div>
          <button ref={menuCloseRef} className="icon-button mobile-menu-close" aria-label="Close menu" onClick={closeMenu}><X size={17} /></button>
        </div>

        <button className="add-item-button" disabled={busy} onClick={() => setEditingItem(null)}>
          <Plus size={17} strokeWidth={2.5} /><span>New item</span><kbd>⌘ N</kbd>
        </button>

        <div className="sidebar-section">
          <p className="sidebar-label">YOUR VAULT</p>
          <button className={`nav-item ${categoryFilter === "all" ? "active" : ""}`} aria-pressed={categoryFilter === "all"} onClick={() => selectCategory("all")}>
            <span className="nav-icon"><LockKeyhole size={16} /></span><span>All items</span><span className="nav-count">{items.length}</span>
          </button>
          <button className={`nav-item ${categoryFilter === "favorites" ? "active" : ""}`} aria-pressed={categoryFilter === "favorites"} onClick={() => selectCategory("favorites")}>
            <span className="nav-icon"><Star size={16} /></span><span>Favorites</span><span className="nav-count">{items.filter((item) => item.favorite).length}</span>
          </button>
        </div>

        <div className="sidebar-section category-section">
          <p className="sidebar-label">CATEGORIES</p>
          {categories.map((category) => {
            const Icon = categoryIcons[category];
            return (
              <button
                key={category}
                className={`nav-item ${categoryFilter === category ? "active" : ""}`}
                aria-pressed={categoryFilter === category}
                onClick={() => selectCategory(category)}
              >
                <span className={`nav-icon category-icon-${category}`}><Icon size={15} /></span>
                <span>{categoryLabels[category]}</span>
                <span className="nav-count">{categoryCounts[category]}</span>
              </button>
            );
          })}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-safe-card">
            <div className="safe-card-top"><span className="safe-indicator" /><span>Vault protected</span><ShieldCheck size={15} /></div>
            <p>Your data is encrypted and stored only on this device.</p>
            <div className="safe-card-divider" />
            <div className="safe-card-foot"><span><Clock3 size={13} /> Auto-lock in 5 min</span><span>3 FACTORS</span></div>
          </div>
          {session?.version === 2 && (
            <button className="nav-item authenticator-nav" disabled={busy} onClick={beginAuthenticatorChange}>
              <span className="nav-icon"><ShieldCheck size={16} /></span><span>Change authenticator</span>
            </button>
          )}
          <button className="nav-item lock-nav" onClick={lockVault}>
            <span className="nav-icon"><LogOut size={16} /></span><span>Lock vault</span><kbd>⌘ L</kbd>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button ref={menuButtonRef} className="icon-button mobile-menu-open" aria-label="Open menu" aria-controls="vault-sidebar" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumb"><span>My vault</span><ChevronDown size={14} /><strong>{heading}</strong></div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={16} />
              <input ref={searchRef} aria-label="Search your vault" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your vault…" />
              <kbd>⌘ K</kbd>
            </label>
            <span className="icon-button help-button" aria-label="Encrypted locally on this device" title="Encrypted locally on this device"><CircleHelp size={17} /></span>
            <div className="topbar-divider" />
            <div className="avatar">PV</div>
          </div>
        </header>

        <div className="content-area">
          <div className="page-heading">
            <div>
              <div className="page-eyebrow"><span className="green-dot" /> YOUR SECURE COLLECTION</div>
              <h1>{heading}</h1>
              <p aria-live="polite" aria-atomic="true">{selectedCount} {selectedCount === 1 ? "item" : "items"} stored privately on this device</p>
            </div>
            <button className="primary-button page-add-button" disabled={busy} onClick={() => setEditingItem(null)}><Plus size={17} /> Add new item</button>
          </div>

          <div className="vault-grid">
            <section className="items-column">
              <div className="list-toolbar">
                <span>{query ? "MATCHING ITEMS" : sortMode === "recent" ? "RECENTLY UPDATED" : "TITLE A–Z"}</span>
                <button className="sort-button" onClick={() => setSortMode((mode) => mode === "recent" ? "title" : "recent")}><Settings2 size={14} /> <span>{sortMode === "recent" ? "Recent" : "A–Z"}</span></button>
              </div>
              {filteredItems.length ? (
                <div className="item-list">
                  {filteredItems.map((item) => (
                    <VaultItemCard
                      key={item.id}
                      item={item}
                      selected={selectedId === item.id}
                      onClick={() => { setSelectedId(item.id); setIsMenuOpen(false); }}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-list">
                  <div className="empty-icon"><Search size={21} /></div>
                  <h3>{items.length ? "No items found" : "Your vault is ready"}</h3>
                  <p>{items.length ? "Try another search or category." : "Save your first password, key, card, or secure note."}</p>
                  {!items.length && <button className="text-button" disabled={busy} onClick={() => setEditingItem(null)}><Plus size={15} /> Add your first item</button>}
                </div>
              )}
              {items.length > 0 && (
                <div className="list-footnote"><ShieldCheck size={14} /><span>Your items are encrypted at rest</span><span className="footnote-dot">·</span><span>Private to this device</span></div>
              )}
            </section>

            <section className="detail-column">
              {selectedItem ? (
                <ItemDetails
                  item={selectedItem}
                  busy={busy}
                  showSecret={showSecret}
                  onToggleSecret={() => setShowSecret((shown) => !shown)}
                  onCopy={copyToClipboard}
                  onEdit={() => setEditingItem(selectedItem)}
                  onDelete={() => void handleDeleteItem(selectedItem)}
                  onFavorite={() => void toggleFavorite(selectedItem)}
                  onToast={showToast}
                />
              ) : (
                <div className="detail-empty">
                  <div className="detail-empty-art"><KeyRound size={31} /></div>
                  <h3>Select an item</h3>
                  <p>Choose an item from your vault to view its secure details.</p>
                  <span><ArrowLeft size={14} /> Your private details appear here</span>
                </div>
              )}
            </section>
          </div>
        </div>

        <footer className="statusbar">
          <div><span className="status-green" /><span>{busy ? (authenticatorSecret ? "Updating authenticator…" : "Saving securely…") : "All changes saved"}</span><span className="status-separator">·</span><span>Encrypted locally</span></div>
          <div><ShieldCheck size={14} /><span>Private & secure</span><button className="status-export" onClick={exportBackup} disabled={busy}><ArrowDownToLine size={13} /> Export backup</button></div>
        </footer>
      </section>

      {isMenuOpen && <button className="sidebar-scrim" aria-label="Close menu" onClick={closeMenu} />}
      {editingItem !== undefined && (
        <ItemEditor
          item={editingItem}
          busy={busy}
          onClose={() => setEditingItem(undefined)}
          onSave={(draft) => void handleSaveItem(draft)}
          onToast={showToast}
        />
      )}
      {authenticatorSecret && (
        <AuthenticatorReplacement
          secret={authenticatorSecret}
          busy={busy}
          error={authenticatorError}
          onCancel={() => {
            setAuthenticatorSecret(null);
            setAuthenticatorError("");
          }}
          onComplete={handleReplaceAuthenticator}
        />
      )}
      <div className={toast ? "toast" : "visually-hidden"} role="status" aria-atomic="true">
        {toast && <><span className="toast-check"><Check size={13} /></span>{toast}</>}
      </div>
    </main>
  );
}

function CreditCardIcon() {
  return <Banknote size={15} />;
}

function PasswordGuidance() {
  return (
    <div className="password-guidance">
      <ShieldCheck size={15} />
      <span>Choose a unique passphrase you can remember.</span>
    </div>
  );
}

function FactorEnrollment({
  setup,
  busy,
  error,
  onComplete,
  onCancel,
}: {
  setup: VaultSetupDraft;
  busy: boolean;
  error: string;
  onComplete: (draft: VaultSetupDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError("");
    if (!(await verifyTotp(setup.factors.totpSecret, code))) {
      setLocalError("That code did not match. Check your authenticator and try again.");
      return;
    }
    try {
      await onComplete(setup);
    } catch {
      return;
    }
  };

  return (
    <>
      <p className="eyebrow">{setup.migrating ? "UPGRADE VAULT PROTECTION" : "THREE-FACTOR SECURITY"}</p>
      <h1>Connect your authenticator</h1>
      <p className="auth-subtitle">
        Scan this code with an authenticator app, then enter its current 6-digit code.
      </p>
      <div className="auth-qr">
        <QRCodeSVG value={totpUri(setup.factors.totpSecret)} size={148} level="M" />
      </div>
      <details className="auth-manual-secret">
        <summary>Can't scan? Enter the setup key manually</summary>
        <code>{setup.factors.totpSecret}</code>
      </details>
      <div className="auth-factor-note">
        <ShieldCheck size={15} />
        <span>
          The device key protects the encrypted vault. TOTP is an extra local sign-in check; save the setup key in your authenticator.
        </span>
      </div>
      {setup.migrating && <p className="migration-note">Your existing entries will be re-encrypted with device protection.</p>}
      <form className="auth-form factor-form" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="setup-totp-code">Authenticator code</label>
        <input
          id="setup-totp-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,8}"
          maxLength={8}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/[^0-9 ]/g, ""))}
          placeholder="6-digit code"
          required
          autoFocus
        />
        {(localError || error) && <p className="form-error" role="alert">{localError || error}</p>}
        <button className="primary-button auth-submit" type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
          {busy ? "Securing your vault…" : "Finish setup"} <ArrowRight size={16} />
        </button>
        <button className="text-button factor-back" type="button" disabled={busy} onClick={onCancel}>
          <ArrowLeft size={14} /> Back
        </button>
      </form>
    </>
  );
}

function AuthenticatorReplacement({
  secret,
  busy,
  error,
  onComplete,
  onCancel,
}: {
  secret: string;
  busy: boolean;
  error: string;
  onComplete: (code: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const dialogRef = useDialogFocus(onCancel, busy);

  return (
    <div className="modal-backdrop">
      <section ref={dialogRef} tabIndex={-1} className="editor-modal authenticator-modal" role="dialog" aria-modal="true" aria-labelledby="authenticator-title">
        <header className="editor-header">
          <div className="editor-header-icon"><ShieldCheck size={18} /></div>
          <div>
            <p className="eyebrow">VAULT SECURITY</p>
            <h2 id="authenticator-title">Change authenticator</h2>
          </div>
          <button className="icon-button editor-close" aria-label="Cancel authenticator change" disabled={busy} onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <form
          className="authenticator-replacement-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onComplete(code);
          }}
        >
          <div className="authenticator-replacement-content">
            <p className="auth-subtitle">
              Scan this new code, then confirm with its current 6-digit code. Your current authenticator stays active until confirmation succeeds.
            </p>
            <div className="auth-qr">
              <QRCodeSVG value={totpUri(secret, "Personal Vault - New")} size={148} level="M" />
            </div>
            <details className="auth-manual-secret">
              <summary>Can't scan? Enter the setup key manually</summary>
              <code>{secret}</code>
            </details>
            <p className="authenticator-warning">Keep the setup key private. After confirmation, the old authenticator will no longer work.</p>
            <label htmlFor="replacement-totp-code">New authenticator code</label>
            <input
              id="replacement-totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^0-9 ]/g, ""))}
              placeholder="6-digit code"
              required
              autoFocus
            />
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="editor-footer">
            <button className="cancel-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
            <button className="primary-button save-button" type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
              {busy ? "Verifying…" : "Confirm and change"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function VaultItemCard({ item, selected, onClick }: { item: VaultItem; selected: boolean; onClick: () => void }) {
  const Icon = categoryIcons[item.category];
  const subtitle = item.username || item.url || item.notes || secretLabels[item.category];
  return (
    <button className={`item-card ${selected ? "item-card-selected" : ""}`} aria-pressed={selected} onClick={onClick}>
      <span className={`item-icon item-icon-${item.category}`}><Icon size={18} strokeWidth={1.8} /></span>
      <span className="item-card-text">
        <span className="item-card-title">{item.title}</span>
        <span className="item-card-subtitle">{subtitle}</span>
      </span>
      <span className="item-card-meta">
        {item.favorite && <Star className="favorite-mark" size={14} fill="currentColor" />}
        <span className="item-card-type">{categoryLabels[item.category]}</span>
      </span>
      <span className="item-card-arrow"><ArrowRight size={15} /></span>
    </button>
  );
}

function ItemDetails({
  item,
  busy,
  showSecret,
  onToggleSecret,
  onCopy,
  onEdit,
  onDelete,
  onFavorite,
  onToast,
}: {
  item: VaultItem;
  busy: boolean;
  showSecret: boolean;
  onToggleSecret: () => void;
  onCopy: (value: string, label: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onFavorite: () => void;
  onToast: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const Icon = categoryIcons[item.category];
  const typeLabel = categoryLabels[item.category];

  return (
    <div className="detail-card">
      <div className="detail-card-top">
        <span className={`detail-item-icon item-icon-${item.category}`}><Icon size={22} strokeWidth={1.8} /></span>
        <button className={`icon-button detail-favorite ${item.favorite ? "is-favorite" : ""}`} disabled={busy} aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"} onClick={onFavorite}>
          <Star size={17} fill={item.favorite ? "currentColor" : "none"} />
        </button>
        <div className="detail-menu-wrap" onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.stopPropagation();
            setMenuOpen(false);
            menuButtonRef.current?.focus();
          }
        }}>
          <button ref={menuButtonRef} className="icon-button" disabled={busy} aria-label="More item actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={19} /></button>
          {menuOpen && (
            <div className="context-menu">
              <button disabled={busy} onClick={() => { onEdit(); setMenuOpen(false); }}><Settings2 size={14} /> Edit item</button>
              <button className="danger-menu" disabled={busy} onClick={() => { onDelete(); setMenuOpen(false); }}><Trash2 size={14} /> Delete item</button>
            </div>
          )}
        </div>
      </div>

      <div className="detail-heading">
        <div><span className="category-pill"><span />{typeLabel}</span><h2>{item.title}</h2></div>
        <button className="edit-button" disabled={busy} onClick={onEdit}><Settings2 size={14} /> Edit</button>
      </div>
      <div className="detail-divider" />

      <div className="detail-fields">
        {item.username && (
          <DetailField label="Username" icon={<AtSign size={14} />} value={item.username} onCopy={() => onCopy(item.username, "Username")} />
        )}
        {item.url && (
          <DetailField
            label="Website"
            icon={<Globe size={14} />}
            value={item.url}
            href={item.url}
            onCopy={() => onCopy(item.url, "Website")}
            onToast={onToast}
          />
        )}
        {item.secret && (
          <div className="detail-field">
            <div className="field-label"><KeyRound size={14} /><span>{secretLabels[item.category]}</span></div>
            <div className="secret-value-row">
              <span className={`field-value secret-value ${showSecret ? "revealed" : ""}`}>{showSecret ? item.secret : "••••••••••••••••••"}</span>
              <div className="field-actions">
                <button className="field-icon-button" aria-label={showSecret ? "Hide secret" : "Show secret"} onClick={onToggleSecret}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button className="field-icon-button" aria-label="Copy secret" onClick={() => onCopy(item.secret, secretLabels[item.category])}><Copy size={14} /></button>
              </div>
            </div>
          </div>
        )}
        {item.customFields.map((field) => (
          <div className="detail-field" key={field.id}>
            <div className="field-label"><Activity size={14} /><span>{field.label}</span></div>
            <div className="secret-value-row">
              <span className={`field-value ${field.secret ? "secret-value" : ""}`}>
                {field.secret ? (showSecret ? field.value : "••••••••••••••••••") : field.value}
              </span>
              {field.value && <button className="field-icon-button" aria-label={`Copy ${field.label}`} onClick={() => onCopy(field.value, field.label)}><Copy size={14} /></button>}
            </div>
          </div>
        ))}
        {item.notes && (
          <div className="detail-field notes-field">
            <div className="field-label"><BookLock size={14} /><span>Secure notes</span></div>
            <p className="notes-value">{item.notes}</p>
            <button className="copy-notes" onClick={() => onCopy(item.notes, "Notes")}><Copy size={13} /> Copy notes</button>
          </div>
        )}
        {item.tags.length > 0 && (
          <div className="detail-field tags-field">
            <div className="field-label"><Sparkles size={14} /><span>Tags</span></div>
            <div className="tag-list">{item.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
          </div>
        )}
      </div>
      <div className="detail-card-footer">
        <div><span className="footer-check"><BadgeCheck size={14} /></span><span>Encrypted & secure</span></div>
        <span>Updated {formatDate(item.updatedAt)}</span>
      </div>
    </div>
  );
}

function DetailField({
  label,
  icon,
  value,
  href,
  onCopy,
  onToast,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  href?: string;
  onCopy: () => void;
  onToast?: (message: string) => void;
}) {
  const openWebsite = () => {
    if (!href) return;
    try {
      const url = new URL(href.includes("://") ? href : `https://${href}`);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only website links can be opened.");
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch {
      onToast?.("This website address is invalid.");
    }
  };
  return (
    <div className="detail-field">
      <div className="field-label">{icon}<span>{label}</span></div>
      <div className="secret-value-row">
        {href ? <button className="field-value link-value" onClick={openWebsite}>{value}</button> : <span className="field-value">{value}</span>}
        <div className="field-actions">
          {href && <button className="field-icon-button" aria-label={`Open ${label}`} onClick={openWebsite}><ArrowRight size={14} /></button>}
          <button className="field-icon-button" aria-label={`Copy ${label}`} onClick={onCopy}><Copy size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function ItemEditor({
  item,
  busy,
  onClose,
  onSave,
  onToast,
}: {
  item: VaultItem | null;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: ItemDraft) => void;
  onToast: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ItemDraft>(() =>
    item
      ? {
          title: item.title,
          category: item.category,
          username: item.username,
          secret: item.secret,
          url: item.url,
          notes: item.notes,
          tags: item.tags.join(", "),
          customFields: item.customFields.map((field) => ({ ...field })),
        }
      : emptyDraft(),
  );
  const [showSecret, setShowSecret] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus(onClose, busy);
  const setField = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const addCustomField = () => {
    const field: CustomField = { id: crypto.randomUUID(), label: "", value: "", secret: false };
    setField("customFields", [...draft.customFields, field]);
  };
  const updateCustomField = (id: string, key: keyof CustomField, value: string | boolean) => {
    setField(
      "customFields",
      draft.customFields.map((field) => (field.id === id ? { ...field, [key]: value } : field)),
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      titleRef.current?.focus();
      return;
    }
    onSave(draft);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <div className="editor-header">
          <div className="editor-header-icon"><Plus size={18} /></div>
          <div><p className="eyebrow">{item ? "UPDATE YOUR ENTRY" : "ADD TO YOUR VAULT"}</p><h2 id="editor-title">{item ? "Edit item" : "New item"}</h2></div>
          <button className="icon-button editor-close" aria-label="Close editor" disabled={busy} onClick={onClose}><X size={18} /></button>
        </div>
        <form className="editor-form" onSubmit={handleSubmit}>
          <div className="editor-scroll">
            <div className="form-row">
              <label className="form-control form-control-wide">
                <span>Item name <b>*</b></span>
                <input ref={titleRef} value={draft.title} onChange={(event) => setField("title", event.target.value)} placeholder="e.g. Personal email" required autoFocus />
              </label>
              <label className="form-control">
                <span>Category</span>
                <select value={draft.category} onChange={(event) => setField("category", event.target.value as Category)}>
                  {categories.map((category) => <option value={category} key={category}>{categoryLabels[category]}</option>)}
                </select>
              </label>
            </div>
            <div className="form-section-label"><span>SECURE DETAILS</span><span>All fields are encrypted</span></div>
            <div className="form-row">
              <label className="form-control">
                <span>Username / identifier</span>
                <input value={draft.username} onChange={(event) => setField("username", event.target.value)} placeholder="Email, account name, or ID" autoComplete="off" />
              </label>
              <label className="form-control">
                <span>{secretLabels[draft.category]}</span>
                <div className="editor-secret-input">
                  <input value={draft.secret} onChange={(event) => setField("secret", event.target.value)} type={showSecret ? "text" : "password"} placeholder="Enter secure value" autoComplete="new-password" />
                  <button type="button" className="secret-input-action" aria-label="Generate secure value" title="Generate a random password" onClick={() => { setField("secret", generatePassword()); setShowSecret(true); onToast("A strong random value was generated"); }}><Sparkles size={15} /></button>
                  <button type="button" className="secret-input-action" aria-label={showSecret ? "Hide value" : "Show value"} onClick={() => setShowSecret((shown) => !shown)}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                </div>
              </label>
            </div>
            <label className="form-control">
              <span>Website / location</span>
              <input value={draft.url} onChange={(event) => setField("url", event.target.value)} placeholder="https://example.com" autoComplete="url" />
            </label>
            <label className="form-control">
              <span>Secure notes</span>
              <textarea value={draft.notes} onChange={(event) => setField("notes", event.target.value)} placeholder="Add private details, recovery codes, or anything else…" rows={3} />
            </label>
            <label className="form-control">
              <span>Tags <small>Separate with commas</small></span>
              <input value={draft.tags} onChange={(event) => setField("tags", event.target.value)} placeholder="personal, work, travel" />
            </label>

            <div className="custom-fields-heading">
              <div><span>Custom fields</span><small>Add any extra details for this item</small></div>
              <button className="outline-small-button" type="button" onClick={addCustomField}><Plus size={14} /> Add field</button>
            </div>
            {draft.customFields.map((field) => (
              <div className="custom-field-row" key={field.id}>
                <input value={field.label} onChange={(event) => updateCustomField(field.id, "label", event.target.value)} placeholder="Field name" aria-label="Custom field name" />
                <input value={field.value} onChange={(event) => updateCustomField(field.id, "value", event.target.value)} placeholder="Value" aria-label="Custom field value" type={field.secret ? "password" : "text"} />
                <button className={`custom-secret-toggle ${field.secret ? "selected" : ""}`} type="button" title={field.secret ? "Mark as visible" : "Mark as secret"} aria-label="Toggle secret field" onClick={() => updateCustomField(field.id, "secret", !field.secret)}><Eye size={14} /></button>
                <button className="custom-remove" type="button" title="Remove field" aria-label="Remove custom field" onClick={() => setField("customFields", draft.customFields.filter((current) => current.id !== field.id))}><X size={15} /></button>
              </div>
            ))}

            <div className="editor-encryption-note"><ShieldCheck size={15} /><span>Your details are encrypted before they are saved to this device.</span></div>
          </div>
          <div className="editor-footer">
            <button type="button" className="cancel-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button save-button" disabled={busy}>{busy ? "Saving…" : item ? "Save changes" : "Save item"} <Check size={15} /></button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default App;
