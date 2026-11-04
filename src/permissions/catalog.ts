// Every permission an endpoint can check (api-list.md §4 and the endpoint tables), with its group and en/hi text.
// GET /admin/permissions (#305) serves this list. `adminOnly`: only an Admin may give it (a Head Doctor can't).
// Keys are typed: requirePermission('x.y') with a key not listed here fails the typecheck.

export const PERMISSION_GROUPS = {
  patients: { en: 'Patients', hi: 'मरीज़' },
  appointments: { en: 'Appointments', hi: 'अपॉइंटमेंट' },
  clinical: { en: 'Clinical', hi: 'क्लिनिकल' },
  nursing: { en: 'Nursing', hi: 'नर्सिंग' },
  prescriptions: { en: 'Prescriptions', hi: 'पर्चे' },
  departments: { en: 'Department records', hi: 'विभाग के रिकॉर्ड' },
  sensitive: { en: 'Sensitive records', hi: 'संवेदनशील रिकॉर्ड' },
  inpatient: { en: 'Admission and discharge', hi: 'भर्ती और छुट्टी' },
  surgery: { en: 'Surgery', hi: 'सर्जरी' },
  documents: { en: 'Documents', hi: 'दस्तावेज़' },
  pharmacy: { en: 'Pharmacy', hi: 'फ़ार्मेसी' },
  stock: { en: 'Stock and inventory', hi: 'स्टॉक और इन्वेंटरी' },
  billing: { en: 'Billing', hi: 'बिलिंग' },
  insurance: { en: 'Insurance', hi: 'बीमा' },
  records: { en: 'Record copies and export', hi: 'रिकॉर्ड की कॉपी और निर्यात' },
  referrals: { en: 'Referrals', hi: 'रेफ़रल' },
  access: { en: 'Access', hi: 'एक्सेस' },
  reports: { en: 'Reports', hi: 'रिपोर्ट' },
  approvals: { en: 'Approvals', hi: 'मंज़ूरी' },
  grants: { en: 'Grants', hi: 'अनुमति देना' },
  payroll: { en: 'Payroll', hi: 'वेतन' },
  compliance: { en: 'Compliance', hi: 'अनुपालन' },
  audit: { en: 'Audit', hi: 'ऑडिट' },
  users: { en: 'Users and roles', hi: 'उपयोगकर्ता और भूमिकाएँ' },
  settings: { en: 'Hospital setup', hi: 'अस्पताल की सेटिंग' },
} as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;

export interface PermissionInfo {
  key: string;
  group: PermissionGroup;
  descriptionEn: string;
  descriptionHi: string;
  adminOnly: boolean;
}

type Row = readonly [key: string, en: string, hi: string, adminOnly?: 'adminOnly'];

const groups = {
  patients: [
    ['patient.search', 'Search patients', 'मरीज़ खोजें'],
    ['patient.view', 'View a patient record', 'मरीज़ का रिकॉर्ड देखें'],
    ['patient.register', 'Register a new patient', 'नया मरीज़ पंजीकृत करें'],
    ['patient.update', 'Edit patient details', 'मरीज़ की जानकारी बदलें'],
    ['patient.merge', 'Merge duplicate patients (needs a second person)', 'दोहरे मरीज़ रिकॉर्ड मिलाएँ (दूसरे व्यक्ति की मंज़ूरी ज़रूरी)'],
  ],
  appointments: [
    ['appointment.view', 'View appointments', 'अपॉइंटमेंट देखें'],
    ['appointment.create', 'Book appointments', 'अपॉइंटमेंट बुक करें'],
    ['appointment.update', 'Change or cancel appointments', 'अपॉइंटमेंट बदलें या रद्द करें'],
  ],
  clinical: [
    ['encounter.view', 'View visits', 'विज़िट देखें'],
    ['encounter.create', 'Open a visit', 'विज़िट शुरू करें'],
    ['encounter.update', 'Edit or close a visit', 'विज़िट बदलें या बंद करें'],
    ['note.write', 'Write clinical notes', 'क्लिनिकल नोट लिखें'],
    ['note.sign', 'Sign clinical notes', 'क्लिनिकल नोट पर हस्ताक्षर करें'],
    ['note.addend', 'Add to a signed note', 'हस्ताक्षरित नोट में जोड़ें'],
    ['diagnosis.write', 'Record diagnoses', 'निदान दर्ज करें'],
    ['problem.write', 'Edit the problem list', 'समस्या सूची बदलें'],
    ['allergy.write', 'Record allergies', 'एलर्जी दर्ज करें'],
    ['order.view', 'View lab and imaging orders', 'जाँच के ऑर्डर देखें'],
    ['order.write', 'Order lab tests and imaging', 'जाँच और इमेजिंग का ऑर्डर दें'],
    ['result.record', 'Enter test results', 'जाँच के नतीजे दर्ज करें'],
    ['vitals.record', 'Record vitals', 'वाइटल्स दर्ज करें'],
    ['observation.record', 'Record observations', 'ऑब्ज़र्वेशन दर्ज करें'],
  ],
  nursing: [
    ['nursing_note.write', 'Write nursing notes', 'नर्सिंग नोट लिखें'],
    ['mar.record', 'Record medicines given (MAR)', 'दी गई दवाएँ दर्ज करें (MAR)'],
  ],
  prescriptions: [
    ['rx.view', 'View prescriptions', 'पर्चे देखें'],
    ['rx.write', 'Write prescriptions', 'पर्चा लिखें'],
    ['rx.upload', 'Upload a paper prescription', 'काग़ज़ी पर्चा अपलोड करें'],
    ['rx.confirm_upload', 'Confirm the lines of an uploaded prescription', 'अपलोड किए गए पर्चे की दवाएँ पक्की करें'],
  ],
  departments: [
    ['dept.dental', 'Dental records', 'दंत रिकॉर्ड'],
    ['dept.ortho', 'Orthopaedic records', 'हड्डी रोग रिकॉर्ड'],
    ['dept.anc', 'Antenatal care records', 'प्रसव-पूर्व देखभाल रिकॉर्ड'],
  ],
  sensitive: [
    ['sensitive.view', 'View records with a sensitive label', 'संवेदनशील लेबल वाले रिकॉर्ड देखें'],
    ['sensitive.label', 'Add or remove sensitive labels', 'संवेदनशील लेबल लगाएँ या हटाएँ'],
    ['pcpndt.view', 'View PC-PNDT records', 'PC-PNDT रिकॉर्ड देखें'],
    ['pcpndt.write', 'Write PC-PNDT records (Form F)', 'PC-PNDT रिकॉर्ड लिखें (फ़ॉर्म F)'],
    ['mtp.view', 'View MTP records', 'MTP रिकॉर्ड देखें'],
    ['mtp.write', 'Write MTP records', 'MTP रिकॉर्ड लिखें'],
  ],
  inpatient: [
    ['admission.create', 'Admit a patient', 'मरीज़ को भर्ती करें'],
    ['admission.update', 'Change bed or admission details', 'बेड या भर्ती की जानकारी बदलें'],
    ['discharge.write', 'Write the discharge summary', 'डिस्चार्ज सारांश लिखें'],
    ['discharge.sign', 'Sign the discharge summary', 'डिस्चार्ज सारांश पर हस्ताक्षर करें'],
  ],
  surgery: [
    ['surgery.view', 'View surgeries', 'सर्जरी देखें'],
    ['surgery.create', 'Plan a surgery', 'सर्जरी तय करें'],
    ['surgery.update', 'Edit a surgery', 'सर्जरी की जानकारी बदलें'],
    ['surgery.op_note', 'Write the operation note', 'ऑपरेशन नोट लिखें'],
    ['surgery.venue_payment', 'Record payments to the surgery venue', 'सर्जरी स्थल को भुगतान दर्ज करें'],
  ],
  documents: [
    ['document.view', 'View documents', 'दस्तावेज़ देखें'],
    ['document.upload', 'Upload documents', 'दस्तावेज़ अपलोड करें'],
    ['document.misfile', 'Mark a document as filed to the wrong patient', 'ग़लत मरीज़ में लगा दस्तावेज़ चिह्नित करें'],
  ],
  pharmacy: [
    ['dispense.view', 'View dispensed medicines', 'दी गई दवाएँ देखें'],
    ['dispense.create', 'Dispense medicines', 'दवाएँ दें'],
    ['pharmacy_bill.view', 'View pharmacy bills', 'फ़ार्मेसी बिल देखें'],
    ['pharmacy_bill.create', 'Make pharmacy bills', 'फ़ार्मेसी बिल बनाएँ'],
    ['pharmacy_refund.create', 'Refund medicines returned by a patient', 'मरीज़ द्वारा लौटाई दवाओं का पैसा लौटाएँ'],
    ['register.print', 'Print statutory drug registers', 'वैधानिक दवा रजिस्टर छापें'],
  ],
  stock: [
    ['stock.view', 'View stock', 'स्टॉक देखें'],
    ['stock.receive', 'Receive stock from a supplier (GRN)', 'सप्लायर से स्टॉक लें (GRN)'],
    ['stock.indent', 'Request stock for a department', 'विभाग के लिए स्टॉक माँगें'],
    ['stock.issue', 'Issue stock to a patient (billed)', 'मरीज़ को स्टॉक दें (बिल में जुड़ेगा)'],
    ['stock.quarantine', 'Quarantine expired or damaged stock', 'ख़राब या एक्सपायर स्टॉक अलग रखें'],
    ['stock.supplier_return', 'Return stock to the supplier', 'सप्लायर को स्टॉक लौटाएँ'],
    ['stock.count', 'Record stock counts', 'स्टॉक गिनती दर्ज करें'],
    ['inventory.add', 'Add a new stock item', 'नया स्टॉक आइटम जोड़ें'],
    ['inventory.manage', 'Edit items, reorder levels and suppliers', 'आइटम, री-ऑर्डर स्तर और सप्लायर बदलें'],
    ['reorder.check', 'Run the reorder check', 'री-ऑर्डर जाँच चलाएँ'],
    ['purchase.create', 'Make purchase orders', 'ख़रीद ऑर्डर बनाएँ'],
  ],
  billing: [
    ['bill.view', 'View bills', 'बिल देखें'],
    ['bill.create', 'Make bills', 'बिल बनाएँ'],
    ['bill.update', 'Edit draft bills', 'ड्राफ़्ट बिल बदलें'],
    ['bill.finalise', 'Finalise bills', 'बिल फ़ाइनल करें'],
    ['bill.void', 'Void bills', 'बिल रद्द करें'],
    ['bill.discount', 'Give discounts', 'छूट दें'],
    ['payment.mark_paid', 'Take payments', 'भुगतान लें'],
    ['deposit.create', 'Take deposits', 'जमा राशि लें'],
    ['deposit.apply', 'Use a deposit on a bill', 'जमा राशि बिल में लगाएँ'],
    ['refund.create', 'Ask for a refund', 'रिफ़ंड का अनुरोध करें'],
  ],
  insurance: [
    ['insurance.policy', 'Add and edit insurance policies', 'बीमा पॉलिसी जोड़ें और बदलें'],
    ['insurance.agent_link', 'Link an insurance agent to a patient', 'बीमा एजेंट को मरीज़ से जोड़ें'],
    ['claim.view', 'View insurance claims', 'बीमा क्लेम देखें'],
    ['claim.create', 'Make insurance claims', 'बीमा क्लेम बनाएँ'],
    ['claim.update', 'Update insurance claims', 'बीमा क्लेम अपडेट करें'],
  ],
  records: [
    ['records.release', 'Release record copies to patients', 'मरीज़ों को रिकॉर्ड की कॉपी दें'],
    ['fhir.export', "Export a patient's records (FHIR)", 'मरीज़ के रिकॉर्ड निर्यात करें (FHIR)'],
    ['fhir.export_all', 'Export the whole database (FHIR)', 'पूरा डेटाबेस निर्यात करें (FHIR)', 'adminOnly'],
  ],
  referrals: [
    ['referrer.view', 'View referring doctors', 'रेफ़र करने वाले डॉक्टर देखें'],
    ['referrer.create_pseudo', 'Add a referring doctor', 'रेफ़र करने वाला डॉक्टर जोड़ें'],
    ['referrer.attach_user', "Link a referring doctor to a user account", 'रेफ़र करने वाले डॉक्टर को यूज़र खाते से जोड़ें'],
    ['referrer.merge', 'Merge duplicate referring doctors', 'दोहरे रेफ़र करने वाले डॉक्टर मिलाएँ'],
    ['referrer.detach', 'Unlink a referring doctor from a user account', 'रेफ़र करने वाले डॉक्टर को यूज़र खाते से अलग करें'],
    ['referral.record', 'Record referrals', 'रेफ़रल दर्ज करें'],
  ],
  access: [
    ['access.request', 'Ask for access to an inactive patient', 'निष्क्रिय मरीज़ के रिकॉर्ड का एक्सेस माँगें'],
    ['breakglass.invoke', 'Emergency access (break-glass)', 'आपातकालीन एक्सेस (ब्रेक-ग्लास)'],
  ],
  reports: [
    ['report.clinical', 'Clinical reports', 'क्लिनिकल रिपोर्ट'],
    ['report.finance', 'Finance reports and day close', 'वित्त रिपोर्ट और दिन का हिसाब'],
  ],
  approvals: [
    ['approval.view', 'See items waiting for approval', 'मंज़ूरी के लिए रुके काम देखें'],
    ['approval.access', 'Approve access requests', 'एक्सेस अनुरोध मंज़ूर करें'],
    ['approval.refund', 'Approve refunds', 'रिफ़ंड मंज़ूर करें'],
    ['approval.discount', 'Approve discounts over the limit', 'सीमा से ज़्यादा छूट मंज़ूर करें'],
    ['approval.payroll', 'Approve payroll runs', 'वेतन मंज़ूर करें'],
  ],
  grants: [
    ['grant.view', 'View grants', 'दी गई अनुमतियाँ देखें'],
    ['grant.create', 'Give a time-limited permission', 'सीमित समय की अनुमति दें'],
    ['grant.revoke', 'Take back a grant', 'दी गई अनुमति वापस लें'],
    ['grant_rule.manage', 'Set who may give which grants', 'तय करें कि कौन कौन-सी अनुमति दे सकता है', 'adminOnly'],
  ],
  payroll: [
    ['payroll.view', 'View payroll', 'वेतन देखें'],
    ['payroll.employee', 'Edit employees and salary structures', 'कर्मचारी और वेतन ढाँचा बदलें'],
    ['payroll.run', 'Run payroll', 'वेतन बनाएँ'],
    ['payroll.bank_file', 'Make the bank payment file (needs a second person)', 'बैंक भुगतान फ़ाइल बनाएँ (दूसरे व्यक्ति की मंज़ूरी ज़रूरी)'],
  ],
  compliance: [
    ['compliance.rights', "Answer patients' data-rights requests", 'मरीज़ों के डेटा अधिकार अनुरोधों का जवाब दें'],
    ['compliance.incident', 'Record and report security incidents', 'सुरक्षा घटनाएँ दर्ज करें और रिपोर्ट करें'],
    ['compliance.legal_hold', 'Place and release legal holds', 'क़ानूनी रोक लगाएँ और हटाएँ'],
    ['compliance.registers', 'Statutory registers and returns', 'वैधानिक रजिस्टर और रिटर्न'],
    ['vital_events.record', 'Record births and deaths', 'जन्म और मृत्यु दर्ज करना'],
  ],
  audit: [
    ['audit.read', 'Read the audit log', 'ऑडिट लॉग पढ़ें'],
    ['audit.review', 'Review break-glass use and do access reviews', 'ब्रेक-ग्लास और एक्सेस की समीक्षा करें'],
  ],
  users: [
    ['user.view', 'View staff accounts', 'स्टाफ़ खाते देखें'],
    ['user.permissions', 'Set custom permissions for staff and staff types', 'स्टाफ़ और स्टाफ़ प्रकार की अनुमतियाँ तय करें'],
    ['user.create', 'Add staff accounts', 'स्टाफ़ खाते जोड़ें', 'adminOnly'],
    ['user.update', 'Edit staff accounts', 'स्टाफ़ खाते बदलें', 'adminOnly'],
    ['user.deactivate', 'Turn off staff accounts', 'स्टाफ़ खाते बंद करें', 'adminOnly'],
    ['user.mfa_reset', "Reset a user's authenticator", 'यूज़र का ऑथेंटिकेटर रीसेट करें', 'adminOnly'],
    ['role.promote_head_doctor', 'Make or remove a Head Doctor', 'हेड डॉक्टर बनाएँ या हटाएँ', 'adminOnly'],
  ],
  settings: [
    ['settings.view', 'View hospital settings', 'अस्पताल की सेटिंग देखें'],
    ['settings.manage', 'Change hospital settings', 'अस्पताल की सेटिंग बदलें', 'adminOnly'],
    ['settings.bundles', 'Edit permission bundles', 'अनुमति बंडल बदलें', 'adminOnly'],
    ['settings.drugs', 'Edit the drug list', 'दवाओं की सूची बदलें', 'adminOnly'],
    ['settings.tariffs', 'Edit prices (tariffs)', 'दरें (टैरिफ़) बदलें', 'adminOnly'],
  ],
} as const satisfies Record<PermissionGroup, readonly Row[]>;

type Groups = typeof groups;
/** Every permission key. */
export type Permission = { [G in keyof Groups]: Groups[G][number][0] }[keyof Groups];

/** The whole catalog, in display order (group by group). */
export const PERMISSIONS: readonly (PermissionInfo & { key: Permission })[] = Object.entries(groups).flatMap(
  ([group, rows]) =>
    (rows as readonly Row[]).map(([key, descriptionEn, descriptionHi, adminOnly]) => ({
      key: key as Permission,
      group: group as PermissionGroup,
      descriptionEn,
      descriptionHi,
      adminOnly: adminOnly === 'adminOnly',
    })),
);

const KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));

/** True for a key in the catalog (for input from users: custom permissions, bundles, grants). */
export const isPermission = (key: string): key is Permission => KEYS.has(key);
