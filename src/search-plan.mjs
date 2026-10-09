export const discoveryQueries=[
 'url:github.com (demo OR playground OR "try online" OR "live app" OR "live demo" OR "interactive demo") -is:retweet',
 'url:github.com ("try it" OR "live preview" OR "try now" OR "deployed" OR "web app") -is:retweet',
 '(url:github.io OR url:vercel.app OR url:netlify.app OR url:pages.dev OR url:streamlit.app) ("open source" OR opensource OR github) (demo OR playground OR "try it" OR launched) -is:retweet'
];
export const popularQueries=discoveryQueries.slice(0,2).map(q=>q+' (min_likes:10 OR min_reposts:3)');
export function searchPlan(config,state){
 const turn=state.queryTurn||0,cap=config.maxPostsPerRun,pop=Math.max(10,Math.round(cap*.3)),discovery=cap-pop;
 const measured=Object.values(state.queryStats||{}).filter(s=>discoveryQueries.includes(s.query)&&s.uniquePosts>=100&&s.validationAttempts>=10).sort((a,b)=>(b.accepted||0)/b.validationAttempts-(a.accepted||0)/a.validationAttempts);
 // Keep two-thirds exploratory; exploit only after a useful sample exists.
 const query=turn%3===2&&measured.length?measured[0].query:discoveryQueries[turn%discoveryQueries.length];
 return [{query,endpoint:'recent',limit:Math.ceil(discovery/2)},
 {query,endpoint:'all',limit:Math.floor(discovery/2)},
 {query:popularQueries[turn%popularQueries.length],endpoint:turn%2?'recent':'all',limit:pop}];
}
export function runConfig(config,input){
 if(input===undefined||input==='')return config;
 const posts=Number(input);if(![50,100].includes(posts))throw Error('Manual post limit must be 50 or 100');
 return {...config,maxPostsPerRun:posts,maximumReservedPerRunUsd:posts*.01,maxRepositoriesPerRun:posts===100?60:config.maxRepositoriesPerRun};
}
