import { createClient } from "@nhost/nhost-js";

export const nhost = createClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || "zvurswochuuxsrfaoebf",
  region: process.env.NEXT_PUBLIC_NHOST_REGION || "ap-south-1",
});