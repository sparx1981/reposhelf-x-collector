import {repoFromUrl,demoHint,iso} from './core.mjs';
export function associatedDemo(candidate,repo,markdown,allow){
 for(const hint of candidate.demoHints||[]){const url=allow(hint);if(!url)continue;
  const link=candidate.demoLinks?.find(v=>v.url===hint&&v.repository.toLowerCase()===repo.full_name.toLowerCase()),source=candidate.sources?.find(s=>s.url===link?.postUrl);
  // Hints are retained only from a post naming one repository, or a demo
  // whose page links to exactly one repository. Multiple-repo posts are ambiguous.
  if(source){candidate.demoEvidence={kind:'x_link',repository:repo.full_name,postUrl:source.url,url};return url;}
 }return null;
}
export async function resolveDemoSeeds({state,config,guard,save,browserFactory,now=Date.now}){
 const seeds=Object.values(state.demoSeeds||{}).filter(s=>!s.nextAttemptAt||Date.parse(s.nextAttemptAt)<=now()).slice(0,config.maxPostsPerRun===100?10:5);if(!seeds.length)return {checked:0,resolved:0};
 let browser;const report={checked:0,resolved:0};
 try{
  browser=browserFactory?await browserFactory():await (await import('playwright')).chromium.launch({headless:true});
  const context=await browser.newContext();await context.route('**/*',async route=>{try{if(['image','media','font'].includes(route.request().resourceType())||!await guard(route.request().url()))await route.abort();else await route.continue();}catch{await route.abort();}});
  for(const seed of seeds){report.checked++;seed.nextAttemptAt=iso(now()+7*86400000);let page;
   try{if(!demoHint(seed.url)||!await guard(seed.url))continue;page=await context.newPage();const response=await page.goto(seed.url,{waitUntil:'domcontentloaded',timeout:15000});if(!response?.ok())continue;
    const names=[...new Set((await page.locator('a[href]').evaluateAll(nodes=>nodes.slice(0,500).map(a=>a.href))).map(repoFromUrl).filter(Boolean))];
    if(names.length!==1){seed.reason=names.length?'ambiguous_repositories':'no_repository_link';continue;}
    const full=names[0],key=full.toLowerCase();const c=state.candidates[key]||={full,firstSeenAt:seed.firstSeenAt,status:'queued',sources:[],query:seed.query};
    c.sources=[...new Map([...c.sources,...seed.sources].map(s=>[s.url,s])).values()].slice(-20);c.demoHints=[...new Set([...(c.demoHints||[]),seed.url])].slice(0,5);c.demoLinks=[...new Map([...(c.demoLinks||[]),{url:seed.url,postUrl:seed.sources[0].url,repository:full}].map(v=>[v.url,v])).values()].slice(0,5);c.engagement=seed.engagement;c.lastSeenAt=iso(now());if(c.reason==='no_hosted_demo'){c.status='queued';delete c.nextAttemptAt;}seed.reason='repository_resolved';seed.nextAttemptAt=iso(now()+90*86400000);report.resolved++;
   }catch{seed.reason='temporary_error';seed.nextAttemptAt=iso(now()+86400000)}finally{if(page)await page.close();await save(state);}
  }
 }finally{if(browser)await browser.close();}
 state.lastDemoDiscovery={...report,at:iso(now())};await save(state);return report;
}
