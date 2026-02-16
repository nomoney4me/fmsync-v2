/* 
  * Contains logics to handle dealstage and substage 
*/


/* dealstages
  *if (student.inactive) deal.stages = deal.stages.map(r => {
    if (r.label == 'Closed Lost') return { ...r, next: true }
    return r;
  }, [])
  // LOGIC based on checklists:
  *if (deal.checklists['Application Form'] != null) deal.stages = deal.stages.map(r => {
    if (r.label == 'Application') return { ...r, next: true }
    return r;
  }, [])

  *if (deal.checklists['Decision'] != null) deal.stages = deal.stages.map(r => {
    if (r.label == 'Decision') return { ...r, next: true }
    return r;
  }, [])

  *if (deal.contract_publish_date != null) deal.stages = deal.stages.map(r => {
    if (r.label == 'Contract Sent') return { ...r, next: true }
    return r;
  }, [])

  *if (deal.checklists['Enrollment Contract Received'] != null) deal.stages = deal.stages.map(r => {
    if (r.label == 'Closed Won') return { ...r, next: true }
    return r;
  }, [])

  *if (deal.candidate_decision == 'I Decline' || deal.school_decision == 'Denied' || student.json.inactive) deal.stages = deal.stages.map(r => {
    if (r.label == 'Closed Lost') return { ...r, next: true }
    return r;
  }, [])



  Substages:
  *13-Application sent (This should be automated within Hubspot or manually changed, after application link is sent to families)
  *14-Application received (Application checklist item is completed)
  *15-Assessment scheduled (Fairmont Admissions Assessment checklist item = Requested)
  *16-Assessment no show (Test short description = Fairmont Admissions Assessment and No Show = True)
  *17-Assessment completed (Fairmont Admissions Assessment checklist item = Complete)
  *18-Re-assessment required (Fairmont Admissions Re-Assessment checklist item = Requested)
  *19-Re-assessment no show (Test short description = Fairmont Admissions Re-Assessment and No Show = True)
  *20-Re-assessment completed (Fairmont Admissions Re-Assessment checklist item = Complete)
  *21-Waiting list application (School Decision = Waitlist)
  *22-Documents missing (Still working on this)

  Substages for Offer/Enrollment:
  *23-Offer sent (School Decision = Accepted)
  *24-Conditional offer sent (School Decision = Accepted w/ Conditions)
  *25-Offer accepted (pending payment) (Enrollment Contract Received checklist item is NOT complete, contract_return_date is NOT null, contract_dep_rec_date IS null)
  *26-Waiting list offer accepted (School Decision = Waitlist w/ Deposit Paid)
  *27-Enrolled (Enrollment Contract Received checklist item = Complete)
  *28-Recyclable (Corresponds to the Closed Lost deal stage, so any current scenario where BB triggers a closed lost deal stage)
*/