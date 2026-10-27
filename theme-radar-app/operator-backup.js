(() => {
 const $=id=>document.getElementById(id),result=$('backup-result'),list=$('backup-list'),create=$('backup-create'),refresh=$('backup-refresh');
 let pending=false;
 async function load(){
  const response=await fetch('/api/backups'),report=await response.json();if(!response.ok)throw Error(report.error||'无法读取本机备份');
  $('backup-scope').textContent=report.note;
  list.replaceChildren(...report.backups.slice(0,5).map(row=>{
   const card=document.createElement('div');card.className='topic';
   const label=document.createElement('span');label.textContent=row.name+' · '+(row.bytes/1024).toFixed(1)+' KiB · '+new Date(row.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' 北京时间';
   const button=document.createElement('button');button.type='button';button.textContent='隔离恢复演练';button.disabled=pending;
   button.onclick=()=>perform('/api/backups/check',{name:row.name});card.append(label,document.createElement('br'),button);return card;
  }));
  if(!report.backups.length)list.textContent='尚无数据库备份。';
  else if(report.total>5){const note=document.createElement('p');note.textContent=`显示最近5份（共${report.total}份）；较早备份可用命令行backup-check核对。`;list.append(note);}
 }
 async function perform(path,body={}){
  if(pending)return;pending=true;create.disabled=true;refresh.disabled=true;for(const b of list.querySelectorAll('button'))b.disabled=true;
  result.textContent=path.endsWith('/create')?'正在生成本机数据库快照。':'正在临时副本中检查完整性与恢复行为，正式账本保持运行。';
  try{
   const state=await(await fetch('/api/state')).json(),response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':state.token},body:JSON.stringify(body)}),report=await response.json();
   if(!response.ok)throw Error(report.error||'数据库备份操作未完成');
   result.textContent=path.endsWith('/create')?'备份已保存：'+report.name+'；完整性检查通过。':`演练通过：${report.tablesVerified}张表逐行一致；在临时副本中将${report.submittingMarkedUncertain}条发送中记录转为不确定，作废${report.runningLeasesRetired}个旧运行租约，保留${report.confirmedDeliveriesPreserved}条已确认送达记录。临时副本已删除；原备份和正式账本未替换，未发信。`;
  }catch(error){result.textContent=error.message;}
  finally{pending=false;create.disabled=false;refresh.disabled=false;await load().catch(e=>result.textContent=e.message);}
 }
 create.onclick=()=>perform('/api/backups/create');refresh.onclick=()=>load().catch(e=>result.textContent=e.message);
 load().catch(e=>result.textContent=e.message);
})();
