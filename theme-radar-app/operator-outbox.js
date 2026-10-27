(() => {
 const $=id=>document.getElementById(id),panel=$('automation-once'),form=$('automation-once-form');let current=null;
 const deliveryLabel=s=>({prepared:'已预留，待领取',submitting:'已领取，待回执',submitted:'已提交，待送达核对',uncertain:'结果不明，禁止重发',sent_confirmed:'已独立确认送达',failed:'发送失败',cancelled:'已取消',bounced:'已退回'}[s]||s);
 async function read(runId){
  panel.hidden=false;$('automation-once-save').disabled=true;$('automation-once-approved').checked=false;$('automation-once-result').textContent='正在读取冻结正文。';panel.scrollIntoView({block:'start',behavior:'smooth'});
  try{const response=await fetch('/api/automation/draft?runId='+encodeURIComponent(runId)),draft=await response.json();if(!response.ok)throw Error(draft.error||'无法读取草稿');current=draft;panel.hidden=false;$('automation-once-subject').textContent=draft.subject;$('automation-once-text').textContent=draft.text;$('automation-once-preview').href=draft.absolutePreview;$('automation-once-hash').textContent='冻结正文 '+draft.contentHash;$('automation-once-approved').checked=false;$('automation-once-save').disabled=!draft.sendReadiness.ready||!!draft.deliveryId;$('automation-once-result').textContent=draft.deliveryId?'已有投递：'+deliveryLabel(draft.deliveryState)+'；不重复登记。':draft.sendReadiness.ready?'可查看正文；要登记一次发送，请填写实际发送宿主与邮箱并明确勾选。':'可查看历史正文；当前不允许登记发送：'+draft.sendReadiness.code;
  }catch(error){current=null;$('automation-once-result').textContent=error.message;}
 }
 document.addEventListener('click',event=>{const button=event.target.closest('[data-automation-draft]');if(button)read(button.dataset.automationDraft);});
 for(const id of ['automation-once-agent','automation-once-from','automation-once-recipient'])$(id).oninput=()=>{$('automation-once-approved').checked=false;};
 form.onsubmit=async event=>{event.preventDefault();if(!current)return;const button=$('automation-once-save');button.disabled=true;
  try{if(!$('automation-once-approved').checked)throw Error('需要明确勾选这份草稿向当前邮箱发送一次。');const state=await(await fetch('/api/state')).json(),body={runId:current.runId,expectedContentHash:current.contentHash,agent:$('automation-once-agent').value,from:$('automation-once-from').value.trim(),recipient:$('automation-once-recipient').value.trim(),approved:true},response=await fetch('/api/automation/mail/prepare',{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:JSON.stringify(body)}),data=await response.json();if(!response.ok)throw Error(data.error||'单封登记未完成');$('automation-once-approved').checked=false;current.deliveryId=data.deliveryId;$('automation-once-result').textContent='已登记单封授权，尚未发送。请在'+body.agent+'核对实际邮箱后领取、发送一次并报告结果；有效期至'+new Date(data.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'北京时间。不会启用原计划。';
  }catch(error){$('automation-once-result').textContent=error.message;button.disabled=false;}
 };
})();
