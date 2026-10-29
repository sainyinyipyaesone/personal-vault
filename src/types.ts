export const categories = [
  "login",
  "card",
  "identity",
  "secure-note",
  "api-key",
  "ssh-key",
  "wifi",
  "other",
] as const;

export type Category = (typeof categories)[number];

export interface CustomField {
  id: string;
  label: string;
  value: string;
  secret: boolean;
}

export interface VaultItem {
  id: string;
  title: string;
  category: Category;
  username: string;
  secret: string;
  url: string;
  notes: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  customFields: CustomField[];
}

export interface ItemDraft {
  title: string;
  category: Category;
  username: string;
  secret: string;
  url: string;
  notes: string;
  tags: string;
  customFields: CustomField[];
}

export const categoryLabels: Record<Category, string> = {
  login: "Login",
  card: "Payment card",
  identity: "Identity",
  "secure-note": "Secure note",
  "api-key": "API key",
  "ssh-key": "SSH key",
  wifi: "Wi-Fi",
  other: "Other",
};

export const secretLabels: Record<Category, string> = {
  login: "Password",
  card: "Card number",
  identity: "Document number",
  "secure-note": "Sensitive value",
  "api-key": "Secret key",
  "ssh-key": "Private key",
  wifi: "Wi-Fi password",
  other: "Secret",
};
