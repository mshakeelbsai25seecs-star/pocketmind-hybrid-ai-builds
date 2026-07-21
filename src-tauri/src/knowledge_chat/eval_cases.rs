use crate::knowledge_chat::partitions::KcSearchScope;
use crate::knowledge_chat::types::KcEvalCase;
use crate::knowledge_chat::types::KcEvalMode;

fn case(id: &str, question: &str, expected_files: &[&str], expected_terms: &[&str]) -> KcEvalCase {
    KcEvalCase {
        id: id.to_string(),
        question: question.to_string(),
        expected_files: expected_files.iter().map(|s| s.to_string()).collect(),
        expected_terms: expected_terms.iter().map(|s| s.to_string()).collect(),
        search_scope: None,
        forbidden_files: Vec::new(),
    }
}

fn scoped_case(
    id: &str,
    question: &str,
    scope: KcSearchScope,
    expected_files: &[&str],
    expected_terms: &[&str],
    forbidden_files: &[&str],
) -> KcEvalCase {
    KcEvalCase {
        id: id.to_string(),
        question: question.to_string(),
        expected_files: expected_files.iter().map(|s| s.to_string()).collect(),
        expected_terms: expected_terms.iter().map(|s| s.to_string()).collect(),
        search_scope: Some(scope),
        forbidden_files: forbidden_files.iter().map(|s| s.to_string()).collect(),
    }
}

/// Scope-specific cases for the bundled test pack. Code scope must surface
/// source files (and never meta query files); Docs scope must surface SOPs
/// (and never rank `.py` parsers over the procedure markdown).
pub fn scope_eval_cases() -> Vec<KcEvalCase> {
    vec![
        scoped_case(
            "scope-code-fortigate-parser",
            "How are FortiGate logs parsed?",
            KcSearchScope::Code,
            &["analyzer.py", "rules.xml"],
            &["fortigate", "parse", "field"],
            &["test_queries", "test_manifest"],
        ),
        scoped_case(
            "scope-docs-vpn-triage",
            "How should VPN brute force be triaged?",
            KcSearchScope::Docs,
            &["vpn-brute-force-triage"],
            &["vpn", "brute", "escalation"],
            &["analyzer.py", "rules.xml"],
        ),
    ]
}

/// Generic folder-quality checks (work on any indexed company pack).
pub fn generic_eval_cases() -> Vec<KcEvalCase> {
    vec![
        // PDF/table/figure quality probes (term-focused; file names vary by corpus).
        case(
            "pdf-table-row-value",
            "What is the value in the rate table for the first row?",
            &[],
            &["table", "rate", "value"],
        ),
        case(
            "pdf-scanned-policy",
            "What does the scanned PDF policy say about access control?",
            &[],
            &["access", "policy", "control"],
        ),
        case(
            "docx-table-lookup",
            "Find the value listed in the document table for SLA or severity.",
            &[],
            &["sla", "severity", "table"],
        ),
        case(
            "spreadsheet-cell-lookup",
            "What values appear in the spreadsheet table columns?",
            &[],
            &["table", "sheet", "value"],
        ),
        case(
            "figure-caption-search",
            "Describe the figure or chart related to the architecture diagram.",
            &[],
            &["figure", "diagram", "architecture"],
        ),
        case(
            "generic-overview",
            "Summarize the main topics covered in this folder.",
            &[],
            &["policy", "procedure", "guide"],
        ),
        case(
            "security-controls",
            "What security controls or requirements are documented?",
            &[],
            &["security", "control", "requirement"],
        ),
        case(
            "escalation",
            "How should incidents be escalated or handled?",
            &[],
            &["escalation", "incident", "handle"],
        ),
        case(
            "testpack-vpn-brute-force",
            "How should VPN brute force followed by successful login be triaged?",
            &["vpn-brute-force-triage"],
            &["vpn", "brute", "escalation", "tier"],
        ),
        case(
            "testpack-severity-sla",
            "What severity levels and SLA response times are defined?",
            &["severity-matrix"],
            &["severity", "sla", "response"],
        ),
        case(
            "testpack-fortigate-parser",
            "How are FortiGate logs parsed and normalized?",
            &["rules.xml", "analyzer.py"],
            &["fortigate", "parser", "field"],
        ),
        // Generic structured-doc retrieval: related fields must surface from XML/rules.
        case(
            "testpack-structured-correlation-fields",
            "What window and threshold fields are defined in the correlation rule XML?",
            &["rules.xml"],
            &["window", "threshold", "rule"],
        ),
        case(
            "meta-pollution-guard",
            "How should VPN brute force followed by successful login be triaged?",
            &["vpn-brute-force-triage"],
            &["vpn", "brute"],
        ),
    ]
}

/// Fortinet SOC / company knowledge retrieval golden queries.
pub fn soc_eval_cases() -> Vec<KcEvalCase> {
    vec![
        // Triage & incident response
        case(
            "soc-triage-vpn-bruteforce",
            "How should VPN brute force followed by successful login be triaged?",
            &["sop", "runbook", "playbook", "triage", "vpn"],
            &["vpn", "brute", "escalation", "triage"],
        ),
        case(
            "soc-triage-phishing",
            "What is the phishing email triage and containment procedure?",
            &["sop", "phish", "runbook", "playbook"],
            &["phish", "email", "containment", "triage"],
        ),
        case(
            "soc-triage-malware",
            "How do we triage a suspected malware infection on an endpoint?",
            &["malware", "sop", "runbook", "ir"],
            &["malware", "endpoint", "isolation", "triage"],
        ),
        case(
            "soc-triage-data-exfil",
            "What steps are documented for investigating data exfiltration?",
            &["exfil", "sop", "runbook", "investigation"],
            &["exfil", "investigation", "data"],
        ),
        case(
            "soc-severity-matrix",
            "What severity levels and SLA response times are defined?",
            &["severity", "sla", "matrix", "policy"],
            &["severity", "sla", "response"],
        ),
        case(
            "soc-escalation-tier2",
            "When should an alert be escalated to tier 2 or management?",
            &["escalation", "sop", "runbook", "tier"],
            &["escalation", "tier", "manager"],
        ),
        case(
            "soc-containment-approval",
            "What human approval is required before containment actions?",
            &["approval", "containment", "playbook", "sop"],
            &["approval", "containment", "human"],
        ),
        case(
            "soc-after-hours",
            "What is the after-hours on-call escalation path?",
            &["on-call", "after", "escalation", "sop"],
            &["on-call", "escalation", "after"],
        ),
        // FortiSIEM rules & detection
        case(
            "soc-fortisiem-correlation",
            "How are FortiSIEM correlation rules documented or tuned?",
            &["fortisiem", "rule", "correlation"],
            &["fortisiem", "correlation", "rule"],
        ),
        case(
            "soc-fortisiem-threshold",
            "What threshold tuning guidance exists for detection rules?",
            &["threshold", "rule", "tuning", "fortisiem"],
            &["threshold", "tuning", "false"],
        ),
        case(
            "soc-fortisiem-mitre",
            "Which MITRE ATT&CK techniques are mapped in detection content?",
            &["mitre", "attack", "rule", "fortisiem"],
            &["mitre", "technique", "tactic"],
        ),
        case(
            "soc-fortisiem-vpn-rule",
            "Is there a detection rule for VPN authentication anomalies?",
            &["vpn", "rule", "fortisiem", "xml"],
            &["vpn", "login", "failed"],
        ),
        case(
            "soc-fortisiem-lateral",
            "What documentation covers lateral movement detection?",
            &["lateral", "rule", "detection"],
            &["lateral", "movement", "detection"],
        ),
        // Parsers & log sources
        case(
            "soc-parser-field-mapping",
            "How should custom log fields be mapped in a FortiSIEM parser?",
            &["parser", "fortisiem", "mapping"],
            &["parser", "field", "mapping"],
        ),
        case(
            "soc-parser-pam",
            "Is there parser guidance for PAM or privileged access logs?",
            &["pam", "parser", "privileged"],
            &["pam", "parser", "privileged"],
        ),
        case(
            "soc-parser-fortigate",
            "How are FortiGate logs parsed and normalized?",
            &["fortigate", "parser", "fortisiem"],
            &["fortigate", "parser", "vpn"],
        ),
        case(
            "soc-log-source-onboarding",
            "What is the process for onboarding a new log source?",
            &["onboard", "log", "source", "connector"],
            &["onboard", "log", "source"],
        ),
        // Playbooks & FortiSOAR
        case(
            "soc-playbook-workflow",
            "What FortiSOAR playbook workflow steps require analyst approval?",
            &["playbook", "fortisoar", "workflow"],
            &["playbook", "approval", "workflow"],
        ),
        case(
            "soc-playbook-containment",
            "Which containment actions are automated vs manual in playbooks?",
            &["playbook", "containment", "fortisoar"],
            &["containment", "playbook", "manual"],
        ),
        case(
            "soc-playbook-enrichment",
            "How is threat intelligence enrichment performed in response playbooks?",
            &["enrichment", "playbook", "ioc"],
            &["enrichment", "ioc", "intelligence"],
        ),
        // Connectors & integrations
        case(
            "soc-connector-auth",
            "What authentication method is used for security tool connectors?",
            &["connector", "auth", "integration"],
            &["connector", "authentication", "api"],
        ),
        case(
            "soc-connector-fortigate",
            "How does the FortiGate connector integration work?",
            &["fortigate", "connector"],
            &["fortigate", "connector", "action"],
        ),
        // Policies & HR / compliance
        case(
            "soc-policy-incident",
            "What is the company incident response policy?",
            &["incident", "policy", "ir"],
            &["incident", "response", "policy"],
        ),
        case(
            "soc-policy-data-classification",
            "How is sensitive data classified and handled?",
            &["classification", "data", "policy"],
            &["classification", "sensitive", "data"],
        ),
        case(
            "soc-policy-employee-termination",
            "What is the employee termination or offboarding security process?",
            &["termination", "offboarding", "hr", "policy"],
            &["termination", "offboarding", "employee"],
        ),
        case(
            "soc-policy-remote-access",
            "What remote access and VPN usage policies apply?",
            &["vpn", "remote", "policy"],
            &["vpn", "remote", "access"],
        ),
        case(
            "soc-policy-password",
            "What password and authentication requirements are documented?",
            &["password", "mfa", "authentication", "policy"],
            &["password", "mfa", "authentication"],
        ),
        // IOC & threat hunting
        case(
            "soc-ioc-hash",
            "How should file hash IOCs be validated and blocked?",
            &["ioc", "hash", "sop"],
            &["hash", "ioc", "block"],
        ),
        case(
            "soc-ioc-ip",
            "What is the procedure for blocking malicious IP addresses?",
            &["ip", "block", "ioc", "firewall"],
            &["block", "ip", "malicious"],
        ),
        case(
            "soc-threat-hunt-hypothesis",
            "Is there guidance on threat hunting hypotheses and baselines?",
            &["hunt", "threat", "baseline"],
            &["hunt", "hypothesis", "baseline"],
        ),
        // Reporting & evidence
        case(
            "soc-evidence-chain",
            "How should evidence be preserved for incident investigations?",
            &["evidence", "chain", "investigation"],
            &["evidence", "preserve", "chain"],
        ),
        case(
            "soc-report-triage",
            "What fields are required in a triage report?",
            &["triage", "report", "template"],
            &["triage", "report", "severity"],
        ),
        case(
            "soc-timeline-reconstruction",
            "How should an incident timeline be reconstructed from logs?",
            &["timeline", "investigation", "log"],
            &["timeline", "reconstruction", "log"],
        ),
        // Network & firewall
        case(
            "soc-firewall-change",
            "What approval is needed for emergency firewall rule changes?",
            &["firewall", "change", "approval"],
            &["firewall", "change", "approval"],
        ),
        case(
            "soc-segmentation",
            "What network segmentation standards are documented?",
            &["segmentation", "network", "policy"],
            &["segmentation", "network", "zone"],
        ),
        // Backup & recovery
        case(
            "soc-backup-restore",
            "What is the ransomware recovery or backup restoration process?",
            &["backup", "restore", "ransomware", "recovery"],
            &["backup", "restore", "recovery"],
        ),
        // Vendor & third party
        case(
            "soc-vendor-notification",
            "When must vendors or third parties be notified of a breach?",
            &["vendor", "breach", "notification"],
            &["vendor", "notification", "breach"],
        ),
        // Training & runbooks
        case(
            "soc-runbook-ransomware",
            "Is there a ransomware response runbook?",
            &["ransomware", "runbook", "playbook"],
            &["ransomware", "runbook", "response"],
        ),
        case(
            "soc-runbook-ddos",
            "How should a DDoS attack be handled according to documentation?",
            &["ddos", "runbook", "sop"],
            &["ddos", "mitigation", "response"],
        ),
        case(
            "soc-runbook-compromised-account",
            "What steps are documented for a compromised user account?",
            &["compromised", "account", "runbook", "sop"],
            &["compromised", "account", "reset"],
        ),
        // Validators & engineering
        case(
            "soc-validator-parser",
            "What validation checks apply to FortiSIEM parser XML?",
            &["parser", "validator", "xml"],
            &["parser", "validation", "xml"],
        ),
        case(
            "soc-validator-playbook",
            "What safety checks are required before deploying a playbook?",
            &["playbook", "validator", "deploy"],
            &["playbook", "validation", "approval"],
        ),
        // Knowledge chat phrasing variants
        case(
            "soc-vague-vpn",
            "VPN policy?",
            &["vpn", "policy"],
            &["vpn", "policy", "access"],
        ),
        case(
            "soc-vague-escalate",
            "who do I escalate to",
            &["escalation", "sop", "on-call"],
            &["escalation", "tier", "contact"],
        ),
        case(
            "soc-acronym-sla",
            "What are our IR SLAs?",
            &["sla", "incident", "severity"],
            &["sla", "incident", "response"],
        ),
        case(
            "soc-acronym-mfa",
            "MFA requirements for admins?",
            &["mfa", "admin", "authentication", "policy"],
            &["mfa", "admin", "authentication"],
        ),
        case(
            "soc-compare-playbook-sop",
            "Compare playbook steps vs SOP for phishing response",
            &["playbook", "sop", "phish"],
            &["playbook", "phishing", "procedure"],
        ),
    ]
}

pub fn all_eval_cases() -> Vec<KcEvalCase> {
    let mut cases = generic_eval_cases();
    cases.extend(soc_eval_cases());
    cases.extend(scope_eval_cases());
    cases.extend(crate::knowledge_chat::qa_standard_cases::qa_corpus_standard_cases());
    cases.extend(crate::knowledge_chat::qa_eval_expanded::qa_corpus_paraphrase_cases());
    cases
}

pub fn eval_cases_for_mode(mode: KcEvalMode) -> Vec<KcEvalCase> {
    match mode {
        KcEvalMode::Generic => generic_eval_cases(),
        KcEvalMode::Soc => soc_eval_cases(),
        KcEvalMode::All => all_eval_cases(),
    }
}

pub fn default_eval_mode(folder_agnostic: bool) -> KcEvalMode {
    if folder_agnostic {
        KcEvalMode::Generic
    } else {
        KcEvalMode::All
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eval_suite_has_soc_coverage() {
        let cases = all_eval_cases();
        assert!(cases.len() >= 40);
        assert!(cases.iter().any(|c| c.id.contains("fortisiem")));
        assert!(cases.iter().any(|c| c.id.contains("playbook")));
    }
}
