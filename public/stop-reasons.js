export function cleanStopReason(value,name=''){
 if(typeof value!=='string')return '';
 let text=value.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu,'').trim();
 for(let i=0;i<2;i++){
  text=text.replace(/^[\s*#，,：:；;—-]+/u,'').replace(/^(?:【推荐原因】|推荐原因)\s*[:：，,]?\s*/u,'');
  if(name&&text.startsWith(name)&&/^[\s，,：:；;—-]/u.test(text.slice(name.length)))text=text.slice(name.length);
 }
 return text.replace(/^[\s*#，,：:；;—-]+/u,'').trim();
}
export function defaultStopReason(stop,preferences={}){
 const texts={自然:'留一段时间欣赏自然景观，让漫游的节奏更从容。',人文:'从人文主题出发，为这段城市漫游增加一个观察与停留的角度。',建筑:'把目光留给建筑细节，为沿途的步行增添不同的观看角度。',展览:'安排一段以展览为主题的停留，让这一天的内容更丰富。',美食:'在游览之间安排一次用餐停留，让行程与吃饭的节奏衔接起来。',休息:'给行程留一点空隙，在继续游览前放慢节奏。'};
 const text=texts[stop.category]||'作为本段路线的停留点，为城市漫游增加一次从容探索的机会。';
 return preferences.interests?.includes(stop.category)?`符合你对${stop.category}的兴趣，${text}`:text;
}
