import { createRemoteJWKSet, jwtVerify } from "jose";

let cachedIssuer = "";
let cachedJwks;

function accessConfig(env) {
  const team = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team)) {
    throw new Error("access_not_configured");
  }
  const issuer = `https://${team}`;
  const audience = String(env.ACCESS_AUD ?? "").trim();
  if (!audience || audience.length > 512) throw new Error("access_not_configured");
  return { issuer, audience };
}

function remoteJwks(issuer) {
  if (issuer !== cachedIssuer || !cachedJwks) {
    cachedIssuer = issuer;
    cachedJwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  }
  return cachedJwks;
}

export async function verifyAccessToken(token, issuer, audience, jwks) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience,
    algorithms: ["RS256"],
  });
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email.includes("@")
  ) {
    throw new Error("identity_required");
  }
  return { subject: payload.sub, email: payload.email };
}

export async function requireHumanAccess(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("access_required");
  const { issuer, audience } = accessConfig(env);
  return verifyAccessToken(token, issuer, audience, remoteJwks(issuer));
}
