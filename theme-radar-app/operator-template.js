(() => {
 const $=id=>document.getElementById(id),out=$('mail-template-result');
 async function load(){const r=await fetch('/api/mail-template'),d=await r.json();if(!r.ok)throw Error(d.error);$('mail-template-json').value=JSON.stringify(d.template,null,2);out.textContent=d.configured?'已加载你的模板。仅应用于之后生成的草稿。':'未保存自定义模板。可修改下方示例后保存；不会启用发信。';}
 $('mail-template-load').onclick=()=>load().catch(e=>out.textContent=e.message);
 $('mail-template-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const value=JSON.parse($('mail-template-json').value),state=await(await fetch('/api/state')).json(),r=await fetch('/api/mail-template',{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:JSON.stringify(value)}),d=await r.json();if(!r.ok)throw Error(d.error);$('mail-template-json').value=JSON.stringify(d.template,null,2);out.textContent='模板已保存；新草稿使用新样式，旧冻结草稿保持原样。未发送邮件。';}catch(e){out.textContent=e.message;}finally{b.disabled=false;}};
 void load().catch(e=>out.textContent=e.message);
})();
