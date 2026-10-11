// Never print identity tokens or the npm credential returned by the exchange.
const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
url.searchParams.set('audience', 'npm:registry.npmjs.org');
const identity = await fetch(url, {headers: {Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}});
if (!identity.ok) throw new Error(`GitHub identity request failed: HTTP ${identity.status}`);
const {value} = await identity.json();
if (!value) throw new Error('GitHub did not return an identity token');
const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
console.log(JSON.stringify({repository:claims.repository,workflow_ref:claims.workflow_ref,job_workflow_ref:claims.job_workflow_ref,ref:claims.ref,aud:claims.aud},null,2));
const packageName = process.env.NPM_PACKAGE;
const exchange = await fetch(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(packageName)}`, {method:'POST',headers:{Authorization:`Bearer ${value}`}});
const body = await exchange.json();
console.log(`npm publisher exchange: HTTP ${exchange.status}`);
if (!exchange.ok) {
  console.error(JSON.stringify({code:body.code, error:body.error, message:body.message},null,2));
  process.exitCode=1;
} else if (!body.token) { throw new Error('npm returned no publish credential'); }
else console.log('Trusted publisher verified. No package was published.');
