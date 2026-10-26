/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (
  failure:
    | "challenge"
    | "timeout"
    | "hold"
    | "hold-timeout"
    | "hold-eof"
    | "hold-startup"
    | "metadata"
    | "budget"
    | "fallback"
    | "duplicate"
    | "aliasduplicate"
    | "cachechallenge"
    | "pagechallenge"
    | "coveragechallenge"
    | "chapterevidence"
    | "chapterfailure"
    | "chapterlater"
    | "oldambiguity"
    | "emptyfallback"
    | "unrelatedfallback"
    | "missingcredits"
    | "missingcapped"
    | "missinginventory"
    | "missingfallback"
    | "missingsparse"
    | "missingactive"
    | "missingowned"
    | "activeverified"
    | "detailfailure"
    | "priormissing"
    | "priorunreadable"
    | "fulltitle"
    | "fulltitleromanized"
    | "fulltitlecapped"
    | "fulltitleemptywords"
    | "fulltitlemissing"
    | "fulltitleknown"
    | "fulltitleambiguous"
    | "fulltitleinterrupted"
    | "fulltitlerescue"
    | "wordrescue"
    | "continue"
    | "continuecap"
    | "continueerror"
    | "continueempty"
    | "continuemissing"
    | "capuseful",
  acceptance: "none" | "dry-run" | "apply" | "resume" = "none",
  maxPages?: number,
) => {
  const directory = mkdtempSync(join(tmpdir(), "manganato-resume-"));
  const first = join(directory, "first.jsonl");
  const second = join(directory, "second.jsonl");
  const third = join(directory, "third.jsonl");
  try {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
      import { BunServices } from '@effect/platform-bun';
      import { Effect } from 'effect';
      import { Command } from 'effect/cli';
      import { mock } from 'bun:test';
      import { PassThrough } from 'node:stream';
      import * as browser from './src/browser-view';
      import { readFileSync, writeFileSync } from 'node:fs';
      for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
      process.env.MANIFOLD_TOKEN = 'secret-fixture-token';
      const failure = ${JSON.stringify(failure)};
      const acceptance = ${JSON.stringify(acceptance)};
      let recovered = false;
      const holding = failure.startsWith('hold');
      if (holding) {
        const input = new PassThrough();
        input.isTTY = true;
        Object.defineProperty(process, 'stdin', {value:input});
      }
      const challenge = () => {
        const saved = readFileSync(${JSON.stringify(first)},'utf8');
        setTimeout(() => {
          if (readFileSync(${JSON.stringify(first)},'utf8').split('"event":"entry"').length !== saved.split('"event":"entry"').length) throw new Error('Advanced a row while paused');
          console.log('HUMAN',failure === 'hold-eof' ? 'EOF' : 'ENTER');
          recovered = true;
          if (failure === 'hold-eof') process.stdin.end();
          else process.stdin.write('\\n');
        },50);
        if (failure === 'hold-timeout') throw new Error('Timeout after 30000ms');
        return {status:403,challenged:true,data:null};
      };
      const continuation = failure.startsWith('continue');
      const bounded = continuation || ['budget','fallback','duplicate','pagechallenge','emptyfallback','unrelatedfallback','capuseful','wordrescue'].includes(failure);
      const chapterEvidence = ['chapterevidence','chapterfailure','chapterlater'].includes(failure);
      const missingCredits = failure.startsWith('missing');
      const active = ['missingactive','activeverified'].includes(failure);
      const aliases = active || missingCredits || chapterEvidence || ['aliasduplicate','cachechallenge','coveragechallenge','oldambiguity','detailfailure','priormissing','priorunreadable'].includes(failure);
      const fullTitle = failure.startsWith('fulltitle');
      const fullTitleName = failure === 'fulltitleemptywords' ? 'Young Again' : 'The Summer You Were There';
      const boundedTitle = failure === 'wordrescue' ? 'Reincarnated Quasar Nebula Pulsar' : 'Reincarnated Quasar Nebula';
      const realNow = Date.now;
      let expired = false;
      if (failure === 'continueempty') Date.now = () => realNow() + (expired ? 90_000_000 : 0);
      let attempt = 0;
      const row = (id, title) => ({
        id, title, provider:'local', providerId:id, createdAt:1, updatedAt:1,
        state:{entryId:id, status:'reading', updatedAt:1},
        providers:[{provider:'mangadex', externalId:id, updatedAt:1}, ...(chapterEvidence ? [{provider:'anilist',externalId:'123',updatedAt:1}] : [])],
      });
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (fullTitle && url.pathname.endsWith('/registry')) return Response.json({entries:[row('target',fullTitleName)]});
        if (url.pathname.endsWith('/registry')) return Response.json({entries:aliases ? [row('target','Giji Harem'),...(failure === 'missingowned' ? [{...row('owner','Already linked'),providers:[{provider:'manganato',externalId:'two',updatedAt:1}]}] : [])] : bounded ? [row('target',boundedTitle)] : [row('done', 'Completed manga'), row('pending', 'Pending manga')]});
        if (url.hostname === 'graphql.anilist.co') {
          if (failure === 'chapterfailure' && attempt === 0) return new Response('unavailable',{status:503});
          return Response.json({data:{Media:{id:123,title:{romaji:'Giji Harem',english:'Pseudo Harem'},synonyms:[],chapters:20,status:'FINISHED'}}});
        }
        if (url.pathname.endsWith('/providers')) {
          if (!fullTitle && !continuation && (acceptance !== 'none' || active)) {
            const report = readFileSync(attempt === 0 ? ${JSON.stringify(first)} : ${JSON.stringify(second)}, 'utf8').trim().split('\\n').map(JSON.parse);
            const decision = report.findLast(line => line.event === 'decision');
            if (!decision || decision.candidateId !== JSON.parse(String(init.body)).externalId || !decision.candidates?.length) throw new Error('Missing persisted prewrite evidence');
            console.log('PREWRITE_DECISION', JSON.stringify(decision));
          }
          console.log('WRITE',init.body);
          return Response.json({...row('target','Giji Harem'),providers:[...row('target','Giji Harem').providers,{provider:'manganato',externalId:JSON.parse(String(init.body)).externalId,updatedAt:1}]});
        }
        if (url.hostname === 'api.mangadex.org') {
          if (failure === 'metadata' && attempt === 0) return new Response('unavailable', {status:503});
          if (fullTitle) return Response.json({data:{attributes:{title:failure === 'fulltitleemptywords' ? {} : {'ja-ro':'Kimi to Tsuzuru Utakata'},altTitles:failure === 'fulltitleemptywords' ? [] : [{en:'The Summer You Were There'},{en:'Ephemeral Spelling With You'},{en:'Transient Spelling With You'},{en:'Kimitsuzu'}]},relationships:failure === 'fulltitlemissing' ? [] : [{type:'author',attributes:{name:'A Creator'}}]}});
          return Response.json({data:{attributes:{title:aliases ? {'ja-ro':'Giji Harem'} : {},altTitles:aliases ? [{en:'Pseudo Harem'}] : []},relationships:[{type:'author',attributes:{name:'A Creator'}}]}});
        }
        throw new Error('Unexpected request: '+url);
      };
      class FixtureView {
        navigate = async () => {};
        close = () => { if (holding) console.log('BROWSER_CLOSED'); };
        evaluate = async (script) => {
          if (script.includes('document.readyState')) {
            if (failure === 'hold-startup' && !recovered) {
              challenge();
              return 'https://www.manganato.gg|loading|Just a moment...';
            }
            return 'https://www.manganato.gg|complete|MangaNato';
          }
          if (script.includes('/api/manga/')) {
            const id = script.match(/\\/api\\/manga\\/([^/]+)\\/chapters/)?.[1];
            console.log('INVENTORY',attempt,id);
            if (failure === 'coveragechallenge' && attempt === 0 && id === 'two') return {status:403,challenged:true,data:null};
            if (failure === 'missinginventory' && id === 'two') return {status:503,challenged:false,data:null};
            const count = active || missingCredits ? (id === 'one' ? 19 : id === 'three' ? 20 : 21) : chapterEvidence ? (id === 'one' ? 19 : id === 'three' ? 24 : 21) : id === 'legacy' ? 9 : failure === 'duplicate' ? (id === 'three' ? 9 : id === 'one' ? 5 : 3) : fullTitle || continuation || ['coveragechallenge','capuseful'].includes(failure) ? (id === 'one' ? 2 : 4) : 2;
            const chapters = Array.from({length:count},(_,i)=>({chapter_slug:'chapter-'+(i+1),chapter_num:i+1,...(active || missingCredits ? {updated_at:id==='two'?'2026-09-01T00:00:00Z':'2026-08-01T00:00:00Z'} : {})}));
            if (active && id === 'one') chapters.push({chapter_slug:'chapter-0',chapter_num:0,updated_at:'2026-08-01T00:00:00Z'}, {chapter_slug:'chapter-1.5',chapter_num:1.5,updated_at:'2026-08-01T00:00:00Z'});
            if (failure === 'missingsparse' && id === 'two') chapters.push({chapter_slug:'chapter-5000',chapter_num:5000,updated_at:'2026-09-01T00:00:00Z'});
            if (failure === 'chapterevidence' && id === 'two') chapters.push({chapter_slug:'chapter-1',chapter_num:1},{chapter_slug:'chapter-1',chapter_num:-1});
            return {status:200,challenged:false,data:{success:true,data:{
              chapters,
              pagination:{total:chapters.length,offset:0,limit:9000,has_more:false},
            }}};
          }
          if (fullTitle) {
            if (script.includes('/search/story/')) {
              const key = script.match(/\\/search\\/story\\/([^?]+)\\?/)?.[1];
              const page = Number(script.match(/\\?page=(\\d+)/)?.[1]);
              console.log('SEARCH',attempt,key,page);
              const fallback = (failure === 'fulltitlerescue' && key === 'tsuzuru') || ['the_summer_you_were_there','kimi_to_tsuzuru_utakata','young_again'].includes(key);
              const remembered = ['fulltitleknown','fulltitleambiguous'].includes(failure);
              if (!fallback || (failure === 'fulltitleromanized' && key === 'the_summer_you_were_there')) return {status:200,challenged:false,data:{title:'Search Results for '+key,next:null,items:[]}};
              if ((remembered || failure === 'fulltitlerescue') && attempt === 0) return {status:403,challenged:true,data:null};
              const capped = failure === 'fulltitlecapped';
              const interrupted = failure === 'fulltitleinterrupted';
              if (interrupted && page === 3 && attempt === 0) return {status:403,challenged:true,data:null};
              return {status:200,challenged:false,data:{title:'Search Results for '+key,
                next:capped || page === 1 || (interrupted && page === 2) ? '/search/story/'+key+'?page='+(page+1) : null,
                items:interrupted && page === 3 ? [] : [{id:page === 1 ? 'one':'two',title:fullTitleName},...(capped ? [{id:'unrelated-'+page,title:'Another title'}] : [])]}};
            }
            if (script.includes('/manga/')) {
              const id = script.includes('/one') ? 'one':'two';
              return {status:200,challenged:false,data:{id,title:fullTitleName,aliases:[],authors:['A Creator']}};
            }
          }
          if (aliases) {
            if (script.includes('/search/story/')) {
              const pseudo = script.includes('/pseudo?');
              console.log('SEARCH', attempt, pseudo ? 'pseudo' : 'giji');
              if (failure === 'cachechallenge') {
                if (pseudo) return {status:200,challenged:false,data:{title:'Search Results for pseudo',next:null,items:[]}};
                if (attempt === 0) return {status:403,challenged:true,data:null};
              }
              if (missingCredits || active) {
                const page = Number(script.match(/\\?page=(\\d+)/)?.[1]);
                const capped = failure === 'missingcapped' || (failure === 'missingfallback' && pseudo);
                return {status:200,challenged:false,data:{title:'Search Results for manga',
                  next:capped || page === 1 ? '/search/story/'+(pseudo?'pseudo':'giji')+'?page='+(page+1):null,
                  items:[...(page === 1 ? ['one','two']:['three']).map(id=>({id,title:'Giji Harem'})),
                    ...(capped ? [{id:'unrelated-'+page,title:'Another title'}] : [])]}};
              }
              if (failure === 'chapterlater' && pseudo) {
                const later = script.includes('page=2');
                return {status:200,challenged:false,data:{title:'Search Results for manga',next:later ? null : '/search/story/pseudo?page=2',items:(later ? ['three']:['one','two']).map(id=>({id,title:'Giji Harem'}))}};
              }
              return {status:200,challenged:false,data:{title:'Search Results for manga',next:null,items:(chapterEvidence || ['coveragechallenge','oldambiguity','detailfailure','priormissing','priorunreadable'].includes(failure) ? ['one','two'] : ['one']).map(id=>({id,title:'Giji Harem'}))}};
            }
            if (script.includes('/manga/')) {
              const two = script.includes('/two');
              const id = script.includes('/legacy') ? 'legacy' : script.includes('/three') ? 'three' : two ? 'two':'one';
              console.log('DETAILS',attempt,id);
              if (failure === 'detailfailure' && attempt === 0 && two) return {status:403,challenged:true,data:null};
              if (failure === 'priorunreadable' && id === 'legacy') return {status:503,challenged:false,data:null};
              return {status:200,challenged:false,data:{id,title:two ? 'Pseudo Harem':'Giji Harem',aliases:[],authors:(missingCredits && two) || (failure === 'priormissing' && id === 'legacy') ? [] : [(chapterEvidence && two) || failure === 'chapterfailure' ? 'Different Pen Name' : 'A Creator']}};
            }
          }
          if (bounded) {
            if (script.includes('/search/story/')) {
              const query = script.match(/\\/search\\/story\\/([^?]+)\\?/)?.[1];
              const page = Number(script.match(/\\?page=(\\d+)/)?.[1]);
              console.log('SEARCH', attempt, query, page);
              if (continuation) {
                if (failure === 'continueempty' && query === 'nebula') expired = true;
                if (failure === 'continueempty' && query === 'quasar' && expired) return {status:200,challenged:false,data:{title:'Search Results for '+query,next:null,items:[]}};
                if (failure === 'continueerror' && query === 'quasar' && page === 6) return {status:503,challenged:false,data:null};
                const complete = query === 'quasar' && page === 6 && failure !== 'continuecap';
                return {status:200,challenged:false,data:{title:'Search Results for '+query,
                  next:complete ? null : '/search/story/'+query+'?page='+(page+1),
                  items:[...((query === 'quasar' || failure === 'continuecap') && page === 1 ? [{id:'one',title:boundedTitle}] : []),...(complete ? [{id:'two',title:boundedTitle}] : []),{id:'unrelated-'+page,title:'Another title'}],
                }};
              }
              if (failure === 'wordrescue') return {status:200,challenged:false,data:{title:'Search Results for '+query,next:null,items:query === 'pulsar' ? [{id:'one',title:boundedTitle}] : []}};
              if (failure === 'emptyfallback' && query === 'quasar') return {status:200,challenged:false,data:{title:'Search Results for quasar',next:null,items:[]}};
              if (failure === 'capuseful') return {status:200,challenged:false,data:{title:'Search Results for '+query,next:query === 'quasar' ? '/search/story/quasar?page='+(page+1) : null,items:[{id:query === 'quasar' ? 'one':'two',title:'Reincarnated Quasar Nebula'},{id:'unrelated-'+page,title:'Another title'}]}};
              if (failure === 'unrelatedfallback') return {status:200,challenged:false,data:{title:'Search Results for '+query,next:query === 'quasar' ? '/search/story/quasar?page='+(page+1) : null,items:[...(query === 'quasar' ? [{id:'one',title:'Reincarnated Quasar Nebula'}] : []),{id:'unrelated-'+page,title:'Another title'}]}};
              if (failure === 'pagechallenge') {
                if (page === 3 && attempt === 0) return {status:403,challenged:true,data:null};
                return {status:200,challenged:false,data:{title:'Search Results for '+query,
                  next:page === 3 ? null : '/search/story/'+query+'?page='+(page+1),
                  items:[{id:page === 1 ? 'unrelated' : page === 2 ? 'one':'two',title:page === 1 ? 'Another title':'Reincarnated Quasar Nebula'}],
                }};
              }
              const complete = (['fallback','emptyfallback'].includes(failure) && query === 'nebula') || (failure === 'duplicate' && page === 2) || page === 6;
              return {status:200,challenged:false,data:{title:'Search Results for '+query,
                next:complete ? null : '/search/story/'+query+'?page='+(page+1),
                items:failure === 'duplicate' ? (page === 1 ? ['one','two'] : ['three']).map(id=>({id,title:'Reincarnated Quasar Nebula'})) : complete ? [{id:'one',title:'Reincarnated Quasar Nebula'}] : [{id:'unrelated-'+page,title:'Another title'}],
              }};
            }
            if (script.includes('/manga/')) {
              const id = script.includes('/one') ? 'one' : script.includes('/three') ? 'three' : 'two';
              console.log('DETAILS',attempt,id);
              return {status:200,challenged:false,data:{id,title:boundedTitle,aliases:[],authors:failure === 'continuemissing' && id === 'two' ? [] : ['A Creator']}};
            }
          }
          const pending = script.includes('pending');
          if (failure === 'timeout' && pending) throw new Error('Timeout after 30000ms');
          if (holding && failure !== 'hold-startup' && attempt === 0 && pending && !recovered) return challenge();
          if (failure === 'challenge' && attempt === 0 && pending) return {status:403,challenged:true,data:null};
          if (script.includes('/search/story/')) return {status:200,challenged:false,data:{
            title:'Search Results for manga', next:null,
            items:(pending ? ['pending'] : ['done-one','done-two']).map(id => ({id,title:pending ? 'Pending manga' : 'Completed manga'})),
          }};
          if (script.includes('/manga/')) return {status:200,challenged:false,data:{
            id:pending ? 'pending' : script.includes('done-one') ? 'done-one' : 'done-two',
            title:pending ? 'Pending manga' : 'Completed manga', aliases:[], authors:['A Creator'],
          }};
          throw new Error('Unexpected browser script');
        };
      }
      mock.module('./src/browser-view', () => ({...browser, openBunBrowserView: () => new FixtureView()}));
      const { makeRootCommand } = await import('./src/cli');
      const flags = ['registry','manganato','--delay','0','--status','reading,paused,planning','--chrome-cdp-url','ws://127.0.0.1:9224/devtools/browser/test'];
      if (${maxPages !== undefined}) flags.push('--max-pages', ${JSON.stringify(String(maxPages))});
      for (const extra of [
        ['--report',${JSON.stringify(first)},...(acceptance !== 'dry-run' && (holding || missingCredits || active || (continuation && acceptance === 'apply')) ? ['--apply'] : []),...(['dry-run','apply'].includes(acceptance) ? ['--accept-recommendations'] : [])],
        ['--report',${JSON.stringify(second)},'--resume',${JSON.stringify(first)},'--limit','1',...(acceptance !== 'dry-run' && (chapterEvidence || missingCredits || active || ((fullTitle || continuation) && acceptance === 'apply')) ? ['--apply'] : []),...(acceptance !== 'none' ? ['--accept-recommendations'] : [])],
        ...(failure === 'budget' ? [['--report',${JSON.stringify(third)},'--resume',${JSON.stringify(second)},'--max-pages','6']] : []),
      ]) {
        try { await Effect.runPromise(Command.runWith(makeRootCommand('test'), {version:'test'})([...flags,...extra]).pipe(Effect.provide(BunServices.layer))); }
        catch (error) {console.info('STOPPED', String(error));}
        if (['oldambiguity','priormissing','priorunreadable'].includes(failure) && attempt === 0) {
          const path = ${JSON.stringify(first)};
          const lines = readFileSync(path,'utf8').trim().split('\\n').map(line=>JSON.parse(line));
          for (const line of lines) if (line.event === 'entry') {
            line.selectionPolicy = 2;
            line.candidates.push({id:'legacy'});
          }
          writeFileSync(path,lines.map(line=>JSON.stringify(line)).join('\\n')+'\\n');
        }
        if (['fulltitleknown','fulltitleambiguous','fulltitlerescue'].includes(failure) && attempt === 0) {
          const path = ${JSON.stringify(first)};
          const lines = readFileSync(path,'utf8').trim().split('\\n').map(JSON.parse);
          for (const line of lines) if (line.event === 'entry') {
            line.outcome = failure === 'fulltitleambiguous' ? 'ambiguous' : 'deferred';
            if (failure === 'fulltitleambiguous') line.selectionPolicy = 10;
            line.deferredReason = 'no_useful_query';
            line.searchPolicy = 5;
            line.retryWhen.searchPolicy = 5;
            line.candidateIds = failure === 'fulltitleambiguous' ? ['one','two'] : ['one'];
          }
          writeFileSync(path,lines.map(line=>JSON.stringify(line)).join('\\n')+'\\n');
        }
        attempt++;
      }
    `,
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return {
      ...result,
      first: readFileSync(first, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      second: readFileSync(second, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      third:
        failure === "budget"
          ? readFileSync(third, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("registry manganato resume", () => {
  it.each([
    [false, "none"],
    [true, "none"],
    [false, "wrong-title"],
    [false, "unreadable"],
    [false, "owned"],
  ] as const)(
    "retries reviewed works with status-changed competitor=%s and preferred listing failure=%s",
    (competitor, preferredFailure) => {
      const directory = mkdtempSync(join(tmpdir(), "manganato-reviewed-"));
      const previous = join(directory, "previous.jsonl");
      const report = join(directory, "report.jsonl");
      try {
        const result = spawnSync(
          "bun",
          [
            "-e",
            `
        import { mock } from 'bun:test';
        import { writeFileSync } from 'node:fs';
        import * as browser from './src/browser-view';
        for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
        const competitor=${competitor};
        const preferredFailure=${JSON.stringify(preferredFailure)};
        const works = [
          ['139415','Kichiku Eiyuu',['kichiku-eiyuu','savage-hero']],
          ['189568','Nigasanai yo? Fukuroji-kun',['nigasanai-yo-fukuroji-kun']],
          ['121426','Yumemi ga Oka Wonderland',['yumemi-ga-oka-wonderland']],
          ['188743',"Marika's Love Meter Malfunction",['marika-chan-no-koukando-wa-bukkowareteiru','marikas-love-meter-malfunction']],
          ['114528','Ii Fuufu no Hanashi.',['a-happy-couple']],
          ['104266','Yuki Nee-chan no Kannou Gokko.',['yuki-nee-chan-no-kan-nou-gokko','yuki-neechan-no-kannou-gokko']],
          ['149329','Dorei wo Choukyoushite Harem Tsukuru',[]],
          ['208491','Ore no Ichizu wo Jama Suru Aitsu',['ore-no-ichizu-wo-jama-suru-aitsu','ore-no-ichizu-o-jama-suru-aitsu']],
          ['157391','Dark Summoner to Dekiteiru',['dark-summoner-to-dekiteiru','i-m-dating-a-dark-summoner']],
          ['212891','Himegoto Kakushigoto',['himegoto-kakushigoto','secret-affairs-hidden-truths']],
          ['210954','Mada Kimi wo Miageteru',['mada-kimi-o-miageteru','im-still-looking-up-at-you']],
          ['153502','Konsei wa Goen ga Arimasu you ni!',['quinpath-romance']],
          ['130872','Fuzoroi no Renri',['fuzoroi-no-renri']],
          ['177188','My Girlfriend Is a Colossal Cutie',['boku-no-kanojo-wa-dekkawaii','my-girlfriend-is-a-colossal-cutie'],['Boku No Kanojo Wa Dekkawaii','My Girlfriend Is a Colossal Cutie']],
          ['135427','Hotel Inhumans',['hotel-inhumans']],
          ['85978','The New Gate',['the-new-gate']],
          ['194023','Kuma to Usagi wa Tomodachi dewa Irarenai',['kuma-to-usagi-wa-tomodachi-de-wa-irarenai','kuma-to-usagi-wa-tomodachi-dewa-irarenai'],['Kuma to Usagi wa Tomodachi de wa Irarenai','Kuma to Usagi wa Tomodachi dewa Irarenai']],
          ['192691','Mikoto-chan wa Kirawaretakunai!',['mikoto-chan-wa-kirawaretakunai','mikoto-chan-doesn-t-want-to-be-hated'],['Mikoto-chan wa Kirawaretakunai!',"Mikoto-chan Doesn't Want to Be Hated!"]],
          ['204271','Haha no Ai wa Mama Naranai!',['haha-no-ai-wa-mama-naranai','my-stepmothers-love-isnt-going-how-i-thought'],['Haha no Ai wa Mama Naranai!',"My Stepmother's Love Isn't Going How I Thought!"]],
          ['153669','Assassin & Cinderella',['assassin-cinderella','assassin-x-cinderella'],['Assassin & Cinderella','Assassin × Cinderella']],
          ['176604','Moto Azadarake no Kanojo ga Shinpai de',['moto-azadarake-no-kanojo-ga-shinpai-de','i-m-worried-about-my-girlfriend-who-used-to-be-covered-in-bruises'],['Moto Azadarake no Kanojo ga Shinpai de',"I'm Worried About My Girlfriend, Who Used to be Covered in Bruises"]],
          ['163643','The Erotical Wizard and His Twelve Brides',['the-erotical-wizard-and-his-twelve-brides','erotical-wizard-to-12-nin-no-hanayome'],['The Erotical Wizard and His Twelve Brides','Erotical Wizard to 12-nin no Hanayome']],
          ['117964','Garbage Brave: Isekai ni Shoukan Sare Suterareta Yuusha no Fukushuu Monogatari',['garbage-brave-isekai-ni-shoukan-sare-suterareta-yuusha-no-fukushuu-monogatari','garbage-hero-a-revenge-story-of-a-hero-who-got-summoned-to-another-world'],['Garbage Brave: Isekai ni Shoukan Sare Suterareta Yuusha no Fukushuu Monogatari','Garbage Hero: A Revenge Story Of A Hero Who Got Summoned To Another World']],
          ['188228','Koisuru Futari wa Kiba wo Kakusu: Gap ga Arisugiru Couple no Hanashi',['koisuru-futari-wa-kiba-wo-kakusu-gap-ga-arisugiru-couple-no-hanashi','koisuru-futari-wa-kiba-o-kakusu-gap-ga-arisugiru-couple-no-hanashi'],['Koisuru Futari wa Kiba wo Kakusu: Gap ga Arisugiru Couple no Hanashi','Koisuru Futari wa Kiba o Kakusu: Gap ga Arisugiru Couple no Hanashi']],
          ['209708','Tatakai Shika Shiranai Onna Kishi wo Amayakashi Tsuzuketa',['tatakai-shika-shiranai-onna-kishi-o-amayakashi-tsuzuketa','tatakai-shika-shiranai-onna-kishi-wo-amayakashi-tsuzuketa'],['Tatakai Shika Shiranai Onna Kishi o Amayakashi Tsuzuketa','Tatakai Shika Shiranai Onna Kishi wo Amayakashi Tsuzuketa']],
          ['168335','Otaku ni Tsumetai Gal',['a-gyaru-who-s-cold-to-otaku','the-gyaru-who-s-cold-to-otaku'],["A Gyaru Who's Cold to Otaku","The Gyaru who's cold to Otaku"]],
          ['174999','Mainichi Ie ni Kuru Gal ga Kyorikan Zero demo Yasashikunai',['mainichi-ie-ni-kuru-gal-ga-kyorikan-zero-demo-yasashikunai','mainichi-ie-ni-kuru-gal-ga-kyorikan-zero-demo-yasashiku-nai','the-gal-who-comes-to-my-house-every-day-has-zero-boundaries-but-isn-t-kind'],['Mainichi Ie ni Kuru Gal ga Kyorikan Zero demo Yasashikunai','Mainichi Ie ni Kuru Gal ga Kyorikan Zero Demo Yasashiku nai',"The Gal Who Comes To My House Every Day Has Zero Boundaries But Isn't Kind"]],
          ['181995','Cool na Doukyuusei no 10-nengo',['cool-na-doukyuusei-no-oo-nengo','cool-na-doukyuusei-no-10-nengo'],['Cool na Doukyuusei no ◯◯ Nengo…','Cool na Doukyuusei no 10 Nengo…']],
          ['133837',"Demon X Angel Can't Get Along!",['demon-x-angel-can-t-get-along','demon-x-angel-cant-get-along'],["Demon X Angel, Can't Get Along!","Demon X Angel, Can’t Get Along!"]],
        ];
        const rows = works.map(([id,title])=>({id,title,provider:'anilist',providerId:id,createdAt:1,updatedAt:1,
          state:{entryId:id,status:'reading',updatedAt:1},providers:[{provider:'anilist',externalId:id,updatedAt:1}]}));
        writeFileSync(${JSON.stringify(previous)},[
          {event:'run',provider:'manganato',reportVersion:1,apply:false,settings:{apiOrigin:'https://fixture.invalid',language:'en'}},
          ...rows.map(row=>({event:'entry',entryId:row.id,title:row.title,outcome:row.id==='114528'?'deferred':row.id==='189568'?'unmatched':'ambiguous',
            ...(competitor && row.id==='114528' && {candidateIds:['unknown-competitor']}),
            ...(row.id==='153502' && {candidateIds:['konsei-wa-goen-ga-arimasu-you-ni','quinpath-romance']}),
            ...(row.id==='130872' && {candidateIds:['fuzoroi-no-renri-side-stories','rationalization-of-irregularities','fuzoroi-no-renri']}),
            selectionPolicy:8,searchPolicy:3,retryWhen:{maxPages:5,searchPolicy:3,selectionPolicy:8},
            fingerprint:JSON.stringify({provider:row.provider,providerId:row.providerId,title:row.title,status:competitor && row.id==='114528'?'paused':'reading',providers:[['anilist',row.id]]})})),
        ].map(line=>JSON.stringify(line)).join('\\n')+'\\n');
        globalThis.fetch = async (input,init={})=>{
          const url=new URL(String(input));
          if(url.pathname.endsWith('/registry')) return Response.json({entries:[...rows,
            ...(preferredFailure==='owned'?[{...rows[0],id:'owner',providerId:'owner',providers:[{provider:'manganato',externalId:'quinpath-romance',updatedAt:1}]}]:[])]});
          if(url.pathname.endsWith('/providers')) {
            const row=rows.find(row=>url.pathname.includes('/'+row.id+'/'));
            const link=JSON.parse(init.body);
            console.log('WRITE',JSON.stringify(link));
            return Response.json({...row,providers:[...row.providers,{provider:'manganato',externalId:link.externalId,updatedAt:1}]});
          }
          throw new Error('Unexpected network request '+url);
        };
        class FixtureView {
          navigate=async()=>{};
          close=()=>{};
          evaluate=async script=>{
            if(script.includes('document.readyState')) return 'https://www.manganato.gg|complete|MangaNato';
            if(script.includes('/api/manga/unknown-competitor/')) return {status:200,challenged:false,data:{success:true,data:{
              chapters:[{chapter_slug:'chapter-1',chapter_num:1}],
              pagination:{offset:0,limit:9000,total:1,has_more:false}}}};
            if(script.includes('/unknown-competitor')) return {status:200,challenged:false,data:{id:'unknown-competitor',title:'A Happy Couple',aliases:[],authors:[]}};
            const suffix=script.includes('/api/manga/')?'/':'"';
            const work=works.find(([, ,ids])=>ids.some(id=>script.includes('/'+id+suffix)));
            if(!work) throw new Error('Unexpected browser request '+script);
            const ids=work[2];
            const id=ids.find(id=>script.includes('/'+id+suffix));
            if(id==='quinpath-romance' && preferredFailure==='unreadable') return {status:503,challenged:false,data:null};
            if(script.includes('/api/manga/')) {
              const count=work[0]==='139415' && id==='kichiku-eiyuu'?2:
                ['the-erotical-wizard-and-his-twelve-brides','cool-na-doukyuusei-no-oo-nengo'].includes(id)?4:3;
              return {status:200,challenged:false,data:{success:true,data:{
                chapters:Array.from({length:count},(_,i)=>({chapter_slug:'chapter-'+(i+1),chapter_num:i+1,
                  updated_at:ids.indexOf(id)===0?'2025-06-05T03:00:25Z':'2025-06-06T11:14:48Z'})),
                pagination:{offset:0,limit:9000,total:count,has_more:false}}}};
            }
            const title=id==='quinpath-romance' && preferredFailure==='wrong-title'?'Different work':work[3]?.[ids.indexOf(id)] ?? work[1];
            return {status:200,challenged:false,data:{id,title,aliases:[],authors:[]}};
          };
        }
        mock.module('./src/browser-view',()=>({...browser,openBunBrowserView:()=>new FixtureView()}));
        Bun.argv=['bun','index.ts','registry','manganato','--api-origin','https://fixture.invalid','--api-token','fixture',
          '--chrome-cdp-url','ws://fixture/browser','--status','reading','--delay','0','--apply',
          '--resume',${JSON.stringify(previous)},'--report',${JSON.stringify(report)}];
        await import('./index.ts');
      `,
          ],
          { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 15_000 },
        );
        expect(result.status, result.stderr + result.stdout).toBe(
          preferredFailure === "none" ? 0 : 1,
        );
        const records = readFileSync(report, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          records
            .filter((line) => line.event === "entry")
            .map((line) => [line.entryId, line.outcome, line.selectedId]),
        ).toEqual([
          ["139415", "matched", "savage-hero"],
          ["189568", "matched", "nigasanai-yo-fukuroji-kun"],
          ["121426", "matched", "yumemi-ga-oka-wonderland"],
          ["188743", "matched", "marikas-love-meter-malfunction"],
          ["114528", competitor ? "ambiguous" : "matched", competitor ? null : "a-happy-couple"],
          ["104266", "matched", "yuki-neechan-no-kannou-gokko"],
          ["149329", "ambiguous", null],
          ["208491", "matched", "ore-no-ichizu-o-jama-suru-aitsu"],
          ["157391", "matched", "i-m-dating-a-dark-summoner"],
          ["212891", "matched", "secret-affairs-hidden-truths"],
          ["210954", "matched", "im-still-looking-up-at-you"],
          [
            "153502",
            preferredFailure === "none"
              ? "matched"
              : preferredFailure === "owned"
                ? "conflicts"
                : "errors",
            preferredFailure === "none" || preferredFailure === "owned" ? "quinpath-romance" : null,
          ],
          ["130872", "matched", "fuzoroi-no-renri"],
          ["177188", "matched", "my-girlfriend-is-a-colossal-cutie"],
          ["135427", "matched", "hotel-inhumans"],
          ["85978", "matched", "the-new-gate"],
          ["194023", "matched", "kuma-to-usagi-wa-tomodachi-dewa-irarenai"],
          ["192691", "matched", "mikoto-chan-doesn-t-want-to-be-hated"],
          ["204271", "matched", "my-stepmothers-love-isnt-going-how-i-thought"],
          ["153669", "matched", "assassin-x-cinderella"],
          [
            "176604",
            "matched",
            "i-m-worried-about-my-girlfriend-who-used-to-be-covered-in-bruises",
          ],
          ["163643", "matched", "the-erotical-wizard-and-his-twelve-brides"],
          [
            "117964",
            "matched",
            "garbage-hero-a-revenge-story-of-a-hero-who-got-summoned-to-another-world",
          ],
          [
            "188228",
            "matched",
            "koisuru-futari-wa-kiba-o-kakusu-gap-ga-arisugiru-couple-no-hanashi",
          ],
          ["209708", "matched", "tatakai-shika-shiranai-onna-kishi-wo-amayakashi-tsuzuketa"],
          ["168335", "matched", "the-gyaru-who-s-cold-to-otaku"],
          ["174999", "ambiguous", null],
          ["181995", "matched", "cool-na-doukyuusei-no-oo-nengo"],
          ["133837", "matched", "demon-x-angel-cant-get-along"],
        ]);
        const matched = 27 - Number(competitor) - Number(preferredFailure !== "none");
        expect(result.stdout.match(/WRITE /g)).toHaveLength(matched);
        expect(result.stdout).toContain('"onConflict":"reject"');
        expect(records.find((line) => line.event === "summary")?.counts).toMatchObject({
          matched,
          ambiguous: competitor ? 3 : 2,
          errors: preferredFailure === "wrong-title" || preferredFailure === "unreadable" ? 1 : 0,
          conflicts: preferredFailure === "owned" ? 1 : 0,
        });
        expect(
          records.find((line) => line.event === "entry" && line.entryId === "130872"),
        ).toMatchObject({
          candidateIds: [
            "fuzoroi-no-renri-side-stories",
            "rationalization-of-irregularities",
            "fuzoroi-no-renri",
          ],
          selectionPolicy: 11,
          note: expect.stringContaining("user-selected listing"),
        });
        expect(
          records.find((line) => line.event === "entry" && line.entryId === "139415")?.candidates,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "savage-hero",
              evidence: expect.objectContaining({ userConfirmed: true, author: "missing" }),
            }),
          ]),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps searching after differing author names and considers the larger later-page competitor", () => {
    const result = run("chapterlater");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "three",
      candidates: [
        { id: "one" },
        { id: "two", evidence: { author: "different", eligible: true } },
        { id: "three" },
      ],
    });
  });

  it("reports verified-anchor chapter support without canonical lookup, and applies only when requested", () => {
    const result = run("chapterevidence");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      applied: false,
      selectedId: "two",
      chapterReference: null,
      candidates: [
        { id: "one", evidence: { author: "verified", eligible: true } },
        {
          id: "two",
          authorMatch: false,
          coverage: {
            count: 21,
            inventory: {
              rawRecords: 23,
              duplicateRecords: 1,
              excludedNegativeRecords: 1,
              normalizedRecords: 0,
            },
          },
          evidence: {
            author: "different",
            chapterSupport: true,
            canonicalChapterSupport: false,
            overlap: [{ anchorId: "one", shared: 19 }],
            score: 85,
            eligible: true,
          },
        },
      ],
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      applied: true,
      selectedId: "two",
    });
    expect(result.stdout.match(/WRITE /g)).toHaveLength(1);
    expect(result.stdout).toContain('"onConflict":"reject"');
  });

  it("retries unresolved author differences after canonical evidence was unavailable", () => {
    const result = run("chapterfailure");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      retryable: true,
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      retryable: false,
    });
  });

  it("reconsiders old ambiguity and retains a known competitor absent from the current searches", () => {
    const result = run("oldambiguity");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "legacy",
      selectionPolicy: 11,
    });
    expect(result.stdout).toContain("DETAILS 1 legacy");
    expect(result.stdout).toContain("INVENTORY 1 legacy");
  });

  it.each(["priormissing", "priorunreadable"] as const)(
    "does not discard an absent %s competitor",
    (failure) => {
      const result = run(failure);
      expect(result.second.find((line) => line.event === "entry")).toMatchObject({
        outcome: failure === "priormissing" ? "ambiguous" : "errors",
        selectedId: null,
        candidateIds: ["one", "two", "legacy"],
      });
      expect(result.stdout).toContain("DETAILS 1 legacy");
    },
  );

  it("resumes the challenged page without repeating earlier pages or details", () => {
    const result = run("pagechallenge");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "challenged",
      candidates: [{ id: "one" }],
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      candidates: [{ id: "one" }, { id: "two" }],
    });
    expect(result.stdout.match(/SEARCH 0 quasar \d/g)).toEqual([
      "SEARCH 0 quasar 1",
      "SEARCH 0 quasar 2",
      "SEARCH 0 quasar 3",
    ]);
    expect(result.stdout.match(/SEARCH 1 quasar \d/g)).toEqual(["SEARCH 1 quasar 3"]);
    expect(result.stdout).not.toContain("DETAILS 1 one");
    expect(result.stdout).toContain("DETAILS 1 two");
  });

  it("stops after fully consuming a useful query and reports omitted aliases", () => {
    const result = run("aliasduplicate");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      queries: ["pseudo"],
      discovery: {
        limitedCoverage: true,
        usefulQuery: "pseudo",
        omittedQueries: ["giji", "giji harem", "pseudo harem"],
        attempts: [{ query: "pseudo", status: "complete", candidateIds: ["one"] }],
      },
    });
    expect(result.stdout.match(/SEARCH 0 /g)).toHaveLength(1);
  });

  it("continues after an empty query and reuses it after a fallback challenge", () => {
    const result = run("cachechallenge");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "challenged",
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
    });
    expect(result.stdout).not.toContain("SEARCH 1 pseudo");
    expect(result.stdout).toContain("SEARCH 1 giji");
  });

  it("continues to the next word when an exhausted query has no exact-title candidates", () => {
    const result = run("emptyfallback");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      queries: ["quasar", "nebula"],
      discovery: {
        usefulQuery: "nebula",
        attempts: [
          { query: "quasar", status: "complete", candidateIds: [] },
          { query: "nebula", status: "complete", candidateIds: ["one"] },
        ],
      },
    });
  });

  it("discovers later-page competitors using the full registry title after word searches miss", () => {
    const result = run("fulltitle");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      discovery: {
        fullTitleQueries: ["the summer you were there", "kimi to tsuzuru utakata"],
        usefulQuery: "the summer you were there",
        attempts: [
          { query: "ephemeral", status: "complete", candidateIds: [] },
          { query: "spelling", status: "complete", candidateIds: [] },
          { query: "transient", status: "complete", candidateIds: [] },
          { query: "kimitsuzu", status: "complete", candidateIds: [] },
          { query: "summer", status: "complete", candidateIds: [] },
          { query: "tsuzuru", status: "complete", candidateIds: [] },
          { query: "there", status: "complete", candidateIds: [] },
          { query: "utakata", status: "complete", candidateIds: [] },
          { query: "were", status: "complete", candidateIds: [] },
          { query: "kimi", status: "complete", candidateIds: [] },
          { query: "the summer you were there", status: "complete", candidateIds: ["one", "two"] },
        ],
        omittedQueries: ["kimi to tsuzuru utakata"],
      },
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it("tries the canonical romanized full title when the complete registry-title search misses", () => {
    const result = run("fulltitleromanized");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      discovery: {
        usefulQuery: "kimi to tsuzuru utakata",
        attempts: expect.arrayContaining([
          expect.objectContaining({
            query: "the summer you were there",
            status: "complete",
            candidateIds: [],
          }),
          expect.objectContaining({
            query: "kimi to tsuzuru utakata",
            status: "complete",
            candidateIds: ["one", "two"],
          }),
        ]),
      },
    });
  });

  it.each([
    ["fulltitle", "matched"],
    ["fulltitleinterrupted", "challenged"],
  ] as const)(
    "revalidates multiple full-title candidates before applying a resumed %s run",
    (mode, firstOutcome) => {
      const result = run(mode, "apply");
      expect(result.first.find((line) => line.event === "entry")).toMatchObject({
        outcome: firstOutcome,
        candidateIds: ["one", "two"],
      });
      expect(result.second.find((line) => line.event === "entry")).toMatchObject({
        outcome: "matched",
        selectedId: "two",
        discovery: { usefulQuery: "the summer you were there" },
      });
      expect(result.stdout.match(/^WRITE /gm)).toHaveLength(1);
      expect(result.stdout).toContain('"externalId":"two"');
    },
  );

  it("can search full titles made entirely of filtered words", () => {
    const result = run("fulltitleemptywords");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      queries: ["young again"],
      discovery: { usefulQuery: "young again" },
    });
  });

  it("never treats a capped full-title search as complete or tries to resolve its duplicates", () => {
    const result = run("fulltitlecapped");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "deferred",
      deferredReason: "page_budget",
      selectedId: null,
      candidateIds: ["one", "two"],
      cappedQueries: ["the summer you were there"],
      discovery: {
        usefulQuery: null,
        omittedQueries: ["kimi to tsuzuru utakata"],
      },
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it("still requires identity evidence after a full-title hit", () => {
    const result = run("fulltitlemissing");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      selectedId: null,
      discovery: { usefulQuery: "the summer you were there" },
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it.each([
    ["fulltitleknown", "matched", "two"],
    ["fulltitleambiguous", "deferred", null],
  ] as const)(
    "reopens old discovery misses without resolving remembered ambiguity: %s",
    (mode, outcome, selectedId) => {
      const result = run(mode);
      expect(result.second.find((line) => line.event === "entry")).toMatchObject({
        outcome,
        selectedId,
        candidateIds: ["one", "two"],
      });
      if (mode === "fulltitleknown") {
        expect(result.second.find((line) => line.event === "entry").discovery.usefulQuery).toBe(
          "the summer you were there",
        );
      } else {
        expect(result.stdout).not.toContain("SEARCH 1 the_summer_you_were_there");
      }
    },
  );

  it("does not unlock a capped candidate using an unrelated completed query", () => {
    const result = run("unrelatedfallback");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "deferred",
      selectedId: null,
      candidateIds: ["one"],
      discovery: {
        usefulQuery: null,
        attempts: [
          { query: "quasar", status: "capped", candidateIds: ["one"] },
          { query: "nebula", status: "complete", candidateIds: [] },
        ],
      },
    });
  });

  it("finishes missing-credit discovery and recommends a larger listing without writing even with --apply", () => {
    const result = run("missingcredits");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      selectedId: null,
      applied: true,
      recommendation: {
        candidateId: "two",
        basis: "missing-credit-inference",
        requiresOptIn: true,
        acceptEligible: true,
        inferred: [
          {
            candidateId: "two",
            overlap: [
              { anchorId: "one", shared: 19 },
              { anchorId: "three", shared: 20 },
            ],
          },
        ],
      },
      discovery: {
        usefulQuery: "pseudo",
        stopReason: "useful_complete_query",
        attempts: [{ status: "complete", candidateIds: ["one", "two", "three"] }],
      },
      candidates: [
        { id: "one", coverage: { count: 19 } },
        {
          id: "two",
          coverage: { count: 21 },
          evidence: { author: "missing", userConfirmed: false, eligible: false },
        },
        { id: "three", coverage: { count: 20 } },
      ],
    });
    expect(result.second.find((line) => line.event === "checkpoint")).toMatchObject({
      outcome: "ambiguous",
      selectedId: null,
      recommendation: { candidateId: "two", requiresOptIn: true },
    });
    expect(result.second.some((line) => line.event === "entry")).toBe(false);
    expect(result.stdout.match(/SEARCH 0 /g)).toHaveLength(2);
    expect(result.stdout).not.toContain("WRITE");
  });

  it.each(["dry-run", "apply", "resume"] as const)(
    "requires explicit opt-in and --apply independently for inferred links (%s)",
    (acceptance) => {
      const result = run("missingactive", acceptance);
      const report = acceptance === "resume" ? result.second : result.first;
      const entry = report.find((line) => line.event === "entry");
      expect(entry).toMatchObject({
        outcome: "matched",
        selectedId: "two",
        acceptedRecommendation: true,
        applied: acceptance !== "dry-run",
        selection: {
          basis: "active-listing",
          lostPositions: [{ candidateId: "one", numbers: [0, 1.5] }],
        },
        recommendation: { requiresOptIn: true, acceptEligible: true },
      });
      expect(entry.candidates.find((candidate) => candidate.id === "two").evidence).toMatchObject({
        author: "missing",
        eligible: false,
        userConfirmed: false,
      });
      expect(report.find((line) => line.event === "decision")).toMatchObject({
        candidateId: "two",
        acceptedRecommendation: true,
        selection: {
          basis: "active-listing",
          lostPositions: [{ candidateId: "one", numbers: [0, 1.5] }],
        },
        recommendation: {
          inferred: [
            {
              candidateId: "two",
              overlap: [
                { anchorId: "one", shared: 19 },
                { anchorId: "three", shared: 20 },
              ],
            },
          ],
        },
        candidates: [
          {
            id: "one",
            evidence: { author: "verified", eligible: true },
            coverage: {
              integerChapters: 19,
              latestChapterUpdatedAt: Date.parse("2026-08-01T00:00:00Z"),
            },
          },
          {
            id: "two",
            evidence: { author: "missing", eligible: false },
            coverage: {
              integerChapters: 21,
              latestChapterUpdatedAt: Date.parse("2026-09-01T00:00:00Z"),
            },
          },
          { id: "three", coverage: { integerChapters: 20 } },
        ],
      });
      expect(report.findIndex((line) => line.event === "decision")).toBeGreaterThanOrEqual(0);
      expect(report.findIndex((line) => line.event === "decision")).toBeLessThan(
        report.findIndex((line) => line.event === "entry"),
      );
      expect(result.stdout).toContain("SELECTION");
      if (acceptance === "dry-run") expect(result.stdout).not.toContain("WRITE");
      else {
        expect(result.stdout).toContain("PREWRITE_DECISION");
        expect(result.stdout).toContain("WRITE");
        expect(result.stdout.indexOf("SELECTION")).toBeLessThan(result.stdout.indexOf("WRITE"));
      }
      if (acceptance === "resume")
        expect(result.first.find((line) => line.event === "entry").outcome).toBe("ambiguous");
    },
  );

  it("keeps sparse recommendations review-only even with opt-in and apply", () => {
    const result = run("missingsparse", "apply");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      selectedId: null,
      acceptedRecommendation: false,
      recommendation: { candidateId: "two", acceptEligible: false },
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it("rejects an owned recommendation even with opt-in and apply", () => {
    const result = run("missingowned", "apply");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "conflicts",
      selectedId: "two",
      acceptedRecommendation: true,
      note: expect.stringContaining("already belongs to owner"),
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it("reports active-listing losses before writing verified duplicates without inference opt-in", () => {
    const result = run("activeverified");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      acceptedRecommendation: false,
      selection: {
        basis: "active-listing",
        lostPositions: [{ candidateId: "one", numbers: [0, 1.5] }],
      },
    });
    expect(result.first.find((line) => line.event === "decision")).toMatchObject({
      candidateId: "two",
      acceptedRecommendation: false,
      candidates: [
        {
          id: "one",
          evidence: { author: "verified", eligible: true },
          coverage: {
            integerChapters: 19,
            latestChapterUpdatedAt: Date.parse("2026-08-01T00:00:00Z"),
          },
        },
        {
          id: "two",
          evidence: { author: "verified", eligible: true },
          coverage: {
            integerChapters: 21,
            latestChapterUpdatedAt: Date.parse("2026-09-01T00:00:00Z"),
          },
        },
        { id: "three", coverage: { integerChapters: 20 } },
      ],
    });
    expect(result.stdout).toContain("SELECTION");
    expect(result.stdout).toContain("PREWRITE_DECISION");
    expect(result.stdout).toContain("WRITE");
    expect(result.stdout.indexOf("SELECTION")).toBeLessThan(result.stdout.indexOf("WRITE"));
  });

  it.each(["missingcapped", "missinginventory", "missingfallback"] as const)(
    "does not recommend or write with incomplete %s evidence",
    (failure) => {
      const result = run(failure, "apply");
      expect(result.first.find((line) => line.event === "entry")).toMatchObject({
        outcome:
          failure === "missingcapped"
            ? "deferred"
            : failure === "missinginventory"
              ? "errors"
              : "ambiguous",
        selectedId: null,
        recommendation: null,
      });
      expect(result.stdout).not.toContain("WRITE");
    },
  );

  it("retains a newly discovered competitor when its details are challenged", () => {
    const result = run("detailfailure");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "challenged",
      candidateIds: ["one", "two"],
      discovery: { attempts: [{ status: "failed" }] },
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      candidateIds: ["one", "two"],
    });
    expect(result.stdout).toContain("DETAILS 1 two");
  });

  it("defers capped queries without repeating them on resume, and retries a changed page budget", () => {
    const result = run("budget");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "deferred",
      deferredReason: "page_budget",
      cappedQueries: ["quasar", "nebula", "reincarnated quasar nebula"],
    });
    expect(result.stdout.match(/SEARCH 0 /g)).toHaveLength(15);
    expect(result.stdout).not.toContain("SEARCH 1 ");
    expect(result.second.filter((line) => line.event === "entry")).toEqual([]);
    expect(result.third.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "one",
    });
  });

  it("rescues a canonical variant omitted by alias ranking while retaining remembered competitors", () => {
    const result = run("fulltitlerescue");
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      candidateIds: ["one", "two"],
      discovery: {
        usefulQuery: "tsuzuru",
        rescueQueries: ["summer", "tsuzuru", "there", "utakata", "were", "kimi"],
      },
    });
    expect(result.stdout).not.toContain("SEARCH 1 the_summer_you_were_there");
  });

  it("tries an unsearched word beyond the first two before broad full-title searches", () => {
    const result = run("wordrescue");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "one",
      queries: ["quasar", "nebula", "pulsar"],
      discovery: { usefulQuery: "pulsar", rescueQueries: ["pulsar"] },
    });
  });

  it("continues one candidate-bearing query and selects the stronger competitor after page five", () => {
    const result = run("continue", "apply");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      candidateIds: ["one", "two"],
      cappedQueries: ["nebula"],
      discovery: {
        usefulQuery: "quasar",
        attempts: [
          {
            query: "quasar",
            status: "complete",
            maxPages: 20,
            continued: true,
            candidateIds: ["one", "two"],
          },
          { query: "nebula", status: "capped", maxPages: 5, candidateIds: [] },
        ],
      },
    });
    expect(result.stdout.match(/SEARCH 0 quasar 1$/gm)).toHaveLength(1);
    expect(result.stdout).toContain('"externalId":"two"');
  });

  it("treats explicit --max-pages 5 as a hard ceiling, unlike the adaptive default", () => {
    const result = run("continue", "apply", 5);
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "deferred",
      deferredReason: "page_budget",
      selectedId: null,
      retryWhen: { maxPages: 5, continuationMaxPages: 5 },
    });
    expect(result.stdout).not.toContain("SEARCH 0 quasar 6");
    expect(result.stdout).not.toContain("WRITE");
  });

  it("stops at page twenty with a next link and never extends a second candidate-bearing query", () => {
    const result = run("continuecap", "apply");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "deferred",
      deferredReason: "page_budget",
      selectedId: null,
      cappedQueries: ["quasar", "nebula"],
      discovery: {
        attempts: [
          { query: "quasar", status: "capped", maxPages: 20, continued: true },
          { query: "nebula", status: "capped", maxPages: 5 },
        ],
      },
    });
    expect(result.stdout).toContain("SEARCH 0 quasar 20");
    expect(result.stdout).not.toContain("SEARCH 0 quasar 21");
    expect(result.stdout).not.toContain("SEARCH 0 nebula 6");
    expect(result.stdout).not.toContain("WRITE");
  });

  it.each(["continueerror", "continueempty"] as const)(
    "does not unlock remembered candidates after %s",
    (mode) => {
      const result = run(mode, "apply");
      expect(result.first.find((line) => line.event === "entry")).toMatchObject({
        outcome: mode === "continueerror" ? "errors" : "deferred",
        selectedId: null,
        candidateIds: ["one"],
        discovery: { usefulQuery: null },
      });
      expect(result.stdout).not.toContain("WRITE");
    },
  );

  it("retains other caps after continuation and blocks missing-credit recommendations", () => {
    const result = run("continuemissing", "apply");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "ambiguous",
      selectedId: null,
      recommendation: null,
      cappedQueries: ["nebula"],
      candidateIds: ["one", "two"],
      discovery: { usefulQuery: "quasar" },
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it("tries another word for a capped alias before giving up", () => {
    const result = run("fallback");
    expect(result.stdout.match(/SEARCH 0 /g)).toHaveLength(6);
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "one",
      queries: ["quasar", "nebula"],
      cappedQueries: ["quasar"],
    });
    expect(result.stdout).not.toContain("SEARCH 1 ");
  });

  it("allows a useful completed fallback after a cap while retaining both competitors", () => {
    const result = run("capuseful");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
      candidateIds: ["one", "two"],
      discovery: {
        usefulQuery: "nebula",
        attempts: [
          { query: "quasar", status: "capped", candidateIds: ["one"] },
          { query: "nebula", status: "complete", candidateIds: ["two"] },
        ],
      },
    });
  });

  it("finishes discovery and selects a larger third duplicate found on a later page", () => {
    const result = run("duplicate");
    expect(result.stdout.match(/SEARCH 0 /g)).toHaveLength(2);
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "three",
      queries: ["quasar"],
      candidates: [
        { id: "one", coverage: { count: 5 } },
        { id: "two", coverage: { count: 3 } },
        { id: "three", coverage: { count: 9 } },
      ],
    });
    expect(result.stdout).not.toContain("SEARCH 1 ");
  });

  it("retries a challenged inventory without fetching saved searches, details or completed inventories again", () => {
    const result = run("coveragechallenge");
    expect(result.first.find((line) => line.event === "entry")).toMatchObject({
      outcome: "challenged",
    });
    expect(result.second.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "two",
    });
    expect(result.stdout).not.toContain("SEARCH 1 ");
    expect(result.stdout).not.toContain("DETAILS 1 ");
    expect(result.stdout).not.toContain("INVENTORY 1 one");
    expect(result.stdout).toContain("INVENTORY 1 two");
  });

  it("continues after a challenge without repeating completed checks or letting them consume --limit", () => {
    const result = run("challenge");
    expect(result.status, result.stderr).toBe(0);
    expect(result.first.filter((line) => line.event === "entry")).toMatchObject([
      { entryId: "done", outcome: "ambiguous" },
      { entryId: "pending", outcome: "challenged" },
    ]);
    expect(result.second.filter((line) => line.event === "entry")).toMatchObject([
      { entryId: "pending", outcome: "matched", selectedId: "pending" },
    ]);
    expect(result.second.find((line) => line.event === "summary")).toMatchObject({
      completed: true,
    });
    expect(JSON.stringify(result.second)).not.toContain("secret-fixture-token");
  });

  it.each(["hold", "hold-timeout", "hold-startup"] as const)(
    "holds for Enter and finishes the same run after %s without replaying writes",
    (scenario) => {
      const result = run(scenario);
      expect(result.stdout).toContain("HUMAN ENTER");
      expect(result.first.filter((line) => line.event === "entry")).toMatchObject([
        { entryId: "done", outcome: "ambiguous" },
        { entryId: "pending", outcome: "matched", selectedId: "pending" },
      ]);
      expect(result.first.find((line) => line.event === "summary")).toMatchObject({
        completed: true,
        counts: { matched: 1, challenged: 0, errors: 0 },
      });
      expect(result.stdout.match(/WRITE /g)).toHaveLength(1);
      expect(result.stdout).toContain('"onConflict":"reject"');
      expect(result.stdout).toContain("BROWSER_CLOSED");
      expect(
        result.first.some((line) => line.event === "progress" && line.message.includes("PAUSED")),
      ).toBe(true);
    },
  );

  it("stops on EOF while held, leaving the interrupted row retryable", () => {
    const result = run("hold-eof");
    expect(result.first.find((line) => line.event === "summary")).toMatchObject({
      completed: false,
      counts: { matched: 0, challenged: 1 },
    });
    expect(result.first.filter((line) => line.event === "entry")).toMatchObject([
      { entryId: "done", outcome: "ambiguous" },
      { entryId: "pending", outcome: "challenged" },
    ]);
    expect(result.stdout).toContain("BROWSER_CLOSED");
    expect(result.stdout).not.toContain("WRITE ");
  });

  it("stops a noninteractive timeout rather than completing or calling it a confirmed challenge", () => {
    const result = run("timeout");
    expect(result.first.find((line) => line.event === "summary")).toMatchObject({
      completed: false,
      counts: { errors: 1, challenged: 0 },
    });
    expect(
      result.first.find((line) => line.entryId === "pending" && line.event === "entry"),
    ).toMatchObject({
      outcome: "errors",
      note: expect.stringContaining("request timed out"),
    });
  });

  it("retries ambiguous rows when their earlier author lookup failed", () => {
    const result = run("metadata");
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.first.find((line) => line.event === "entry" && line.entryId === "done"),
    ).toMatchObject({ outcome: "ambiguous", retryable: true });
    expect(result.second.filter((line) => line.event === "entry")).toMatchObject([
      { entryId: "done", outcome: "ambiguous", retryable: false },
    ]);
  });
});
