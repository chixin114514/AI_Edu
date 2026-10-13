async (page) => {
  // All actions operate on the application's real UI. The only injected DOM is
  // a recording annotation for the pointer; no product data or responses change.
  await page.evaluate(() => {
    const dot = document.createElement('div');
    dot.id = 'film-pointer';
    Object.assign(dot.style, {position:'fixed',left:'0',top:'0',width:'22px',height:'22px',borderRadius:'50%',background:'#1f7a5540',border:'2px solid #1f7a55',boxShadow:'0 0 0 5px #ffffffb0',pointerEvents:'none',zIndex:'2147483647',opacity:'0',transform:'translate(370px,720px)'});
    document.body.append(dot);
    window.filmPoint = {x:370,y:720};
  });
  const started = Date.now();
  const at = async sec => { const remaining=sec*1000-(Date.now()-started); if(remaining>0)await page.waitForTimeout(remaining); };
  const mark = name => console.log('FILM '+name+' '+((Date.now()-started)/1000).toFixed(3));
  const scroll = async y => {await page.evaluate(top=>window.scrollTo({top,behavior:'smooth'}),y);await page.waitForTimeout(650);};
  const point = async locator => {
    let b=await locator.boundingBox();
    if(!b)throw new Error('Missing target');
    if(b.y<68||b.y+b.height>770){
      await locator.evaluate(el=>el.scrollIntoView({behavior:'smooth',block:'center'}));
      await page.waitForTimeout(600); b=await locator.boundingBox();
    }
    const xy={x:b.x+b.width/2,y:b.y+b.height/2};
    await page.evaluate(({x,y})=>{
      const d=document.querySelector('#film-pointer'),p=window.filmPoint;
      d.style.opacity='1';
      d.animate([{transform:`translate(${p.x-11}px,${p.y-11}px)`},{transform:`translate(${x-11}px,${y-11}px)`}],{duration:450,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});
      window.filmPoint={x,y};
    },xy);
    await page.mouse.move(xy.x,xy.y,{steps:12});
    await page.waitForTimeout(450);
    await page.evaluate(()=>{const d=document.querySelector('#film-pointer');d.animate([{boxShadow:'0 0 0 4px #1f7a5540'},{boxShadow:'0 0 0 18px #1f7a5500'}],{duration:550});});
  };
  const tap=async locator=>{await point(locator);await locator.click();};
  mark('start');
  await at(1.8); await tap(page.getByRole('button',{name:'建筑',exact:true})); mark('interest');
  await at(3.2); await scroll(440);
  await at(4.5); await tap(page.getByRole('button',{name:'生成行程',exact:true}));
  await page.getByRole('button',{name:'开始漫游',exact:true}).waitFor();mark('trip');
  await at(7.0); await scroll(235);
  await at(8.2); await tap(page.getByRole('button',{name:'详情',exact:true}).first());mark('detail');
  await at(10.3);await tap(page.getByRole('button',{name:'关闭弹窗',exact:true}));await scroll(0);
  await at(12.0);await tap(page.getByRole('button',{name:'开始漫游',exact:true}));mark('consent');
  await at(14.0);await tap(page.getByRole('button',{name:'同意并开始',exact:true}));
  await page.getByRole('button',{name:'有点累 少走一点，找地方歇歇'}).waitFor();mark('journey');
  await at(16.2);await tap(page.getByRole('button',{name:'有点累 少走一点，找地方歇歇'}));mark('feedback');
  await at(18.2);await scroll(240);
  await at(20.5);await tap(page.getByRole('button',{name:'保留原路线',exact:true}));mark('reject');
  await at(22.1);await tap(page.getByRole('button',{name:'想吃饭 就近安排一家餐厅'}));mark('hungry');
  await at(24.0);await scroll(280);
  await at(26.0);await tap(page.getByRole('button',{name:'接受调整',exact:true}));mark('accept');
  await at(27.5);await scroll(0);
  await at(28.7);await tap(page.getByRole('button',{name:'写两句，拍几张',exact:true}));mark('journal');
  await point(page.getByRole('textbox',{name:'这一刻',exact:true}));
  await page.getByRole('textbox',{name:'这一刻',exact:true}).click();
  await page.getByRole('textbox',{name:'这一刻',exact:true}).pressSequentially('示例记录：沿湖观察，按自己的节奏出发。',{delay:55});
  await at(33.0);await tap(page.getByRole('button',{name:'保存日记',exact:true}));mark('saved');
  await at(34.5);await scroll(0);
  await at(35.4);await tap(page.getByRole('button',{name:'逛完了，去下一站',exact:true}));mark('checkin');
  await at(37.2);await tap(page.getByRole('button',{name:'结束漫游',exact:true}));
  await at(38.8);await tap(page.getByRole('button',{name:'结束，看手记',exact:true}));mark('report');
  await at(40.5);await scroll(385);
  await at(42.0);await page.evaluate(()=>{document.querySelector('#film-pointer').style.opacity='0';});
  await at(45.0);mark('done');
}
