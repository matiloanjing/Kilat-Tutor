'use client';
/**
 * useJobResume Hook - Resume polling for in-progress jobs after page refresh
 * 
 * Features:
 * - Saves jobId to localStorage on submit
 * - Resumes polling on page mount if active job exists
 * - Cleans up localStorage on job completion/failure
 * 
 * Usage:
 * const { saveJob, resumeActiveJob, pollJobStatus, clearJob } = useJobResume('kilatcode', projectId);
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { useState, useCallback, useRef } from 'react';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    agent?: string;
    status?: 'pending' | 'streaming' | 'complete' | 'error';
}

interface JobResumeConfig {
    agentName: string;
    sessionId: string;
    maxPolls?: number;
    pollInterval?: number;
    onProgress?: (progress: number, step: string) => void;
    onComplete?: (job: any) => void;
    onFailed?: (error: string) => void;
    setIsProcessing?: (value: boolean) => void;
    setMessages?: React.Dispatch<React.SetStateAction<Message[]>>;
    setGeneratedFiles?: (files: Record<string, string> | null) => void;
}

export function useJobResume(config: JobResumeConfig) {
    const {
        agentName,
        sessionId,
        maxPolls = 300,
        pollInterval = 1000,
        onProgress,
        onComplete,
        onFailed,
        setIsProcessing,
        setMessages,
        setGeneratedFiles
    } = config;

    const [activeJobId, setActiveJobId] = useState<string | null>(null);
    const pollingRef = useRef<boolean>(false);

    // Get localStorage key for this session
    const getStorageKey = useCallback(() => {
        return `kilat_active_job_${agentName}_${sessionId}`;
    }, [agentName, sessionId]);

    // Save job to localStorage
    const saveJob = useCallback((jobId: string) => {
        localStorage.setItem(getStorageKey(), jobId);
        setActiveJobId(jobId);
        console.log(`💾 [${agentName}] Job saved:`, jobId);
    }, [getStorageKey, agentName]);

    // Clear job from localStorage
    const clearJob = useCallback(() => {
        localStorage.removeItem(getStorageKey());
        setActiveJobId(null);
        console.log(`🗑️ [${agentName}] Job cleared`);
    }, [getStorageKey, agentName]);

    // Poll job status
    const pollJobStatus = useCallback(async (jobId: string, assistantMessageId?: string): Promise<any> => {
        if (pollingRef.current) {
            console.log(`⏳ [${agentName}] Already polling, skipping`);
            return null;
        }

        pollingRef.current = true;
        let completed = false;
        let pollCount = 0;
        let lastJob: any = null;

        console.log(`🔄 [${agentName}] Starting poll for job:`, jobId);

        while (!completed && pollCount < maxPolls && pollingRef.current) {
            await new Promise(r => setTimeout(r, pollInterval));
            pollCount++;

            try {
                const statusRes = await fetch(`/api/kilat/status?jobId=${jobId}`);
                const statusData = await statusRes.json();
                const job = statusData.job;
                lastJob = job;

                if (job?.status === 'completed') {
                    completed = true;
                    clearJob();

                    if (setMessages && assistantMessageId) {
                        setMessages(prev => prev.map(m =>
                            m.id === assistantMessageId
                                ? {
                                    ...m,
                                    content: job.result?.content || 'Generation complete!',
                                    status: 'complete' as const,
                                }
                                : m
                        ));
                    }

                    if (job.result?.files && setGeneratedFiles) {
                        setGeneratedFiles(job.result.files);
                    }

                    onComplete?.(job);
                    setIsProcessing?.(false);
                } else if (job?.status === 'failed') {
                    completed = true;
                    clearJob();

                    const errorMsg = job.error || 'Job failed';
                    if (setMessages && assistantMessageId) {
                        setMessages(prev => prev.map(m =>
                            m.id === assistantMessageId
                                ? {
                                    ...m,
                                    content: `❌ Error: ${errorMsg}`,
                                    status: 'error' as const,
                                }
                                : m
                        ));
                    }

                    onFailed?.(errorMsg);
                    setIsProcessing?.(false);
                } else {
                    // Update progress
                    const progress = job?.progress || 0;
                    const step = job?.currentStep || 'Processing...';
                    onProgress?.(progress, step);
                }
            } catch (error) {
                console.error(`❌ [${agentName}] Polling error:`, error);
            }
        }

        pollingRef.current = false;
        return lastJob;
    }, [agentName, maxPolls, pollInterval, clearJob, onProgress, onComplete, onFailed, setIsProcessing, setMessages, setGeneratedFiles]);

    // Resume active job on mount
    const resumeActiveJob = useCallback(async (): Promise<boolean> => {
        const savedJobId = localStorage.getItem(getStorageKey());
        if (!savedJobId) return false;

        console.log(`🔄 [${agentName}] Checking for active job:`, savedJobId);

        try {
            const statusRes = await fetch(`/api/kilat/status?jobId=${savedJobId}`);
            const statusData = await statusRes.json();
            const job = statusData.job;

            if (job?.status === 'processing' || job?.status === 'pending') {
                console.log(`▶️ [${agentName}] Resuming active job at`, job.progress, '%');
                setActiveJobId(savedJobId);
                setIsProcessing?.(true);
                onProgress?.(job.progress || 0, job.currentStep || 'Resuming...');

                // Add resume message
                const resumeMessage: Message = {
                    id: `msg_resume_${Date.now()}`,
                    role: 'assistant',
                    content: '🔄 Resuming in-progress job...',
                    timestamp: Date.now(),
                    agent: agentName,
                    status: 'streaming',
                };
                setMessages?.(prev => [...prev, resumeMessage]);

                // Continue polling
                pollJobStatus(savedJobId, resumeMessage.id);
                return true;
            } else if (job?.status === 'completed') {
                console.log(`✅ [${agentName}] Job completed while away`);
                clearJob();
                if (job.result?.files && setGeneratedFiles) {
                    setGeneratedFiles(job.result.files);
                }
                onComplete?.(job);
                return true;
            } else {
                // Job failed or not found
                clearJob();
                return false;
            }
        } catch (error) {
            console.error(`❌ [${agentName}] Failed to resume job:`, error);
            clearJob();
            return false;
        }
    }, [agentName, getStorageKey, clearJob, pollJobStatus, onProgress, onComplete, setIsProcessing, setMessages, setGeneratedFiles]);

    // Stop polling
    const stopPolling = useCallback(() => {
        pollingRef.current = false;
        console.log(`⏹️ [${agentName}] Polling stopped`);
    }, [agentName]);

    return {
        activeJobId,
        saveJob,
        clearJob,
        pollJobStatus,
        resumeActiveJob,
        stopPolling
    };
}
